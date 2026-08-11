import { App, FileSystemAdapter, normalizePath } from "obsidian";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Engine, TikzSettings } from "../settings/settings";
import { BlockKind, EnginePlan, RenderResult } from "./types";
import { ConcurrencyLimiter } from "./concurrency";
import { probeAllExecutables, TeXExecutableName, texLiveExecutableCandidates } from "./executable-detector";
import { augmentPreamble } from "./tex-package-detector";
import { TeXDependencyResolver } from "./tex-dependency-resolver";

const execFileAsync = promisify(execFile);
const PIPELINE_VERSION = "19-wrapper-and-tex-diagnostics";
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_DEPENDENCY_RETRIES = 3;

export class RenderError extends Error {
  constructor(message: string, readonly details?: string) { super(message); this.name = "RenderError"; }
}

export class RenderService {
  private readonly inFlight = new Map<string, Promise<RenderResult>>();
  private readonly limiter = new ConcurrencyLimiter(1);

  constructor(private readonly app: App, private readonly getSettings: () => TikzSettings) {}
  dispose(): void { this.inFlight.clear(); }

  async render(source: string, kind: BlockKind): Promise<RenderResult> {
    const settings = this.getSettings();
    const plan = selectEngine(source, settings);
    const hash = this.hash(source, kind, plan, settings);
    const existing = this.inFlight.get(hash);
    if (existing) return existing;
    const task = this.limiter.run(() => this.renderUnique(source, kind, plan, hash, settings));
    this.inFlight.set(hash, task);
    try { return await task; } finally { this.inFlight.delete(hash); }
  }

  async clearCache(): Promise<void> { await fs.rm(this.cacheRoot(), { recursive: true, force: true }); }

  async testInstallation(): Promise<{ summary: string; results: Awaited<ReturnType<typeof probeAllExecutables>> }> {
    const settings = this.getSettings();
    const results = await probeAllExecutables({ latex: settings.latexPath, pdflatex: settings.pdflatexPath, xelatex: settings.xelatexPath, lualatex: settings.lualatexPath, dvilualatex: settings.dvilualatexPath, dvisvgm: settings.dvisvgmPath, mutool: settings.mutoolPath });
    return { summary: results.map((x) => `${x.name}: ${x.ok ? "OK" : "FAILED"}`).join("\n"), results };
  }

  async detectExecutables(): Promise<Partial<TikzSettings>> {
    const settings = this.getSettings();
    const fromRoot = texLiveExecutableCandidates(settings.texLiveRoot);
    const configured = { latex: fromRoot.latex ?? settings.latexPath, pdflatex: fromRoot.pdflatex ?? settings.pdflatexPath, xelatex: fromRoot.xelatex ?? settings.xelatexPath, lualatex: fromRoot.lualatex ?? settings.lualatexPath, dvilualatex: fromRoot.dvilualatex ?? settings.dvilualatexPath, dvisvgm: fromRoot.dvisvgm ?? settings.dvisvgmPath, mutool: fromRoot.mutool ?? settings.mutoolPath } satisfies Partial<Record<TeXExecutableName, string>>;
    const results = await probeAllExecutables(configured);
    const output: Partial<TikzSettings> = {};
    for (const result of results) if (result.ok) (output as Record<string, unknown>)[`${result.name}Path`] = result.configuredPath;
    return output;
  }

  private async renderUnique(source: string, kind: BlockKind, plan: EnginePlan, hash: string, settings: TikzSettings): Promise<RenderResult> {
    const cache = this.cacheRoot();
    const cached = path.join(cache, `${hash}.svg`);
    if (await this.exists(cached)) return { hash, svg: await fs.readFile(cached, "utf8"), engine: plan.engine, fromCache: true, source, kind };

    const work = path.join(cache, `work-${hash}-${Math.random().toString(36).slice(2, 10)}`);
    await fs.mkdir(cache, { recursive: true });
    await fs.mkdir(work, { recursive: true });

    let effectivePreamble = augmentPreamble(settings.preamble, source);
    let lastLog = "";

    try {
      const resolver = new TeXDependencyResolver(settings.texLiveRoot, plan.executable);
      effectivePreamble = (await resolver.resolve(settings.preamble, source, effectivePreamble)).preamble;

      for (let attempt = 0; attempt <= MAX_DEPENDENCY_RETRIES; attempt += 1) {
        const tex = buildDocument(source, settings, effectivePreamble);
        await fs.writeFile(path.join(work, "main.tex"), tex, "utf8");
        try {
          await this.run(plan.executable, compilerArgs("main.tex", work, plan.outputType), work, settings.compileTimeout);
          lastLog = await this.readLog(work);
          break;
        } catch (error) {
          lastLog = await this.readLog(work);
          if (attempt >= MAX_DEPENDENCY_RETRIES) throw this.normalizeError(error, lastLog);
          const resolved = await resolver.resolveFromLog(source, effectivePreamble, lastLog);
          if (!resolved.added.length) throw this.normalizeError(error, lastLog);
          effectivePreamble = resolved.preamble;
        }
      }

      const extension = plan.outputType === "pdf" ? "pdf" : "xdv";
      const input = path.join(work, `main.${extension}`);
      if (!await this.exists(input)) throw new RenderError(`TeX compiler completed without producing ${path.basename(input)}.`, lastLog);
      const svg = await this.convertToSvg(input, plan.outputType, work, settings);
      await fs.writeFile(cached, svg, "utf8");
      return { hash, svg, engine: plan.engine, fromCache: false, source, kind };
    } catch (error) {
      if (error instanceof RenderError && error.message.includes("--- TeX log ---")) throw error;
      throw this.normalizeError(error, lastLog || await this.readLog(work));
    } finally {
      if (!settings.keepTexSource) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async convertToSvg(input: string, outputType: EnginePlan["outputType"], work: string, settings: TikzSettings): Promise<string> {
    const output = path.join(work, "main.svg");
    if (outputType === "pdf") {
      const mutool = settings.mutoolPath.trim() || "mutool";
      const result = await this.runCapture(mutool, ["draw", "-q", "-F", "svg", "-o", "-", input, "1"], work, settings.compileTimeout);
      const stdout = String(result.stdout ?? "").trim();
      if (stdout.startsWith("<svg") || /<svg\b/i.test(stdout)) {
        const svgStart = stdout.search(/<svg\b/i);
        await fs.writeFile(output, stdout.slice(svgStart), "utf8");
      }
      if (!await this.exists(output)) await this.run(mutool, ["draw", "-q", "-F", "svg", "-o", output, input, "1"], work, settings.compileTimeout);
      if (!await this.exists(output)) {
        const numbered = path.join(work, "main-1.svg");
        if (await this.exists(numbered)) await fs.rename(numbered, output);
      }
    } else {
      const dvisvgm = settings.dvisvgmPath.trim() || "dvisvgm";
      let dvisvgmError: unknown = undefined;
      try {
        await this.run(dvisvgm, ["--exact-bbox", "--no-fonts", "--verbosity=0", input, "-o", output], work, settings.compileTimeout);
      } catch (error) { dvisvgmError = error; }
      if (!await this.exists(output)) {
        const candidates = [path.join(work, "main-1.svg"), path.join(work, "main-01.svg")];
        for (const candidate of candidates) if (await this.exists(candidate)) { await fs.rename(candidate, output); break; }
      }
      if (!await this.exists(output)) {
        const dvipdfmx = resolveSiblingExecutable(settings.latexPath, "dvipdfmx");
        const pdf = path.join(work, "main-from-dvi.pdf");
        try {
          await this.run(dvipdfmx, ["-o", pdf, input], work, settings.compileTimeout);
          if (await this.exists(pdf)) {
            const mutool = settings.mutoolPath.trim() || "mutool";
            const result = await this.runCapture(mutool, ["draw", "-q", "-F", "svg", "-o", "-", pdf, "1"], work, settings.compileTimeout);
            const stdout = String(result.stdout ?? "").trim();
            const svgStart = stdout.search(/<svg\b/i);
            if (svgStart >= 0) await fs.writeFile(output, stdout.slice(svgStart), "utf8");
            if (!await this.exists(output)) await this.run(mutool, ["draw", "-q", "-F", "svg", "-o", output, pdf, "1"], work, settings.compileTimeout);
            if (!await this.exists(output)) {
              const numbered = path.join(work, "main-from-dvi-1.svg");
              if (await this.exists(numbered)) await fs.rename(numbered, output);
            }
          }
        } catch (fallbackError) {
          const dviMessage = dvisvgmError instanceof Error ? dvisvgmError.message : String(dvisvgmError ?? "unknown dvisvgm error");
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new RenderError(`DVI to SVG conversion failed. dvisvgm: ${dviMessage}\nDVI→PDF→SVG fallback: ${fallbackMessage}`);
        }
      }
    }
    if (!await this.exists(output)) {
      const files = await fs.readdir(work).catch(() => []);
      throw new RenderError(`The vector converter completed without producing an SVG file. Files in work directory: ${files.join(", ")}`);
    }
    return sanitizeSvg(await fs.readFile(output, "utf8"));
  }

  private hash(source: string, kind: BlockKind, plan: EnginePlan, settings: TikzSettings): string {
    return createHash("sha256").update(JSON.stringify({ source, kind, engine: plan.engine, executable: plan.executable, outputType: plan.outputType, preamble: augmentPreamble(settings.preamble, source), font: settings.persianFont, dvisvgm: settings.dvisvgmPath, mutool: settings.mutoolPath, pipeline: PIPELINE_VERSION })).digest("hex");
  }

  private cacheRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new RenderError("TikZ Renderer requires Obsidian Desktop with a filesystem-backed vault.");
    return path.join(adapter.getBasePath(), normalizePath(this.getSettings().cacheFolder));
  }

  private async run(executable: string, args: string[], cwd: string, timeout: number): Promise<void> {
    try { await execFileAsync(executable, args, { cwd, timeout, windowsHide: true, maxBuffer: MAX_OUTPUT }); }
    catch (error) {
      const x = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
      if (x.code === "ENOENT") throw new RenderError(`Executable not found: ${executable}`, x.message);
      if (x.code === "ETIMEDOUT" || x.killed) throw new RenderError(`Process timed out after ${timeout} ms: ${executable}`, x.stderr ?? x.message);
      if (x.code === "EACCES") throw new RenderError(`Permission denied: ${executable}`, x.message);
      throw new RenderError(`Process failed: ${executable}`, [x.stderr, x.stdout, x.message].filter(Boolean).join("\n"));
    }
  }

  private async runCapture(executable: string, args: string[], cwd: string, timeout: number): Promise<{ stdout?: string; stderr?: string }> {
    try {
      const result = await execFileAsync(executable, args, { cwd, timeout, windowsHide: true, maxBuffer: MAX_OUTPUT });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    } catch (error) {
      const x = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
      if (x.code === "ENOENT") throw new RenderError(`Executable not found: ${executable}`, x.message);
      if (x.code === "ETIMEDOUT" || x.killed) throw new RenderError(`Process timed out after ${timeout} ms: ${executable}`, x.stderr ?? x.message);
      if (x.code === "EACCES") throw new RenderError(`Permission denied: ${executable}`, x.message);
      throw new RenderError(`Process failed: ${executable}`, [x.stderr, x.stdout, x.message].filter(Boolean).join("\n"));
    }
  }

  private async exists(file: string): Promise<boolean> { return fs.stat(file).then((s) => s.isFile()).catch(() => false); }
  private async readLog(work: string): Promise<string> { try { return await fs.readFile(path.join(work, "main.log"), "utf8"); } catch { return "No TeX log was produced."; } }
  private normalizeError(error: unknown, log: string): RenderError {
    const base = error instanceof RenderError ? error : new RenderError("TeX/TikZ rendering failed", String(error));
    const normalized = log.replace(/\r\n/g, "\n");
    const errorLines = normalized.split("\n").filter((line) => /(?:^|\s)!|LaTeX Error:|Package .* Error:|Emergency stop|Fatal error|Undefined control sequence|Missing \\endgroup|Runaway argument|File .* not found/i.test(line)).slice(-24);
    const lastSection = normalized.slice(Math.max(0, normalized.length - 12000));
    const diagnostic = errorLines.length ? `\n\n--- TeX diagnostics ---\n${errorLines.join("\n")}` : "";
    const detail = lastSection.length > 30000 ? `${lastSection.slice(-30000)}\n[log truncated]` : lastSection;
    return new RenderError(`${base.message}${diagnostic}\n\n--- TeX log (tail) ---\n${detail}`, base.details);
  }
}

export function selectEngine(source: string, settings: TikzSettings): EnginePlan {
  let engine: Exclude<Engine, "auto">;
  const text = `${settings.preamble}\n${source}`;
  if (settings.engine !== "auto") engine = settings.engine;
  else if (/\\usepackage\s*\{\s*(?:xepersian|fontspec)\s*\}|[\u0600-\u06ff]/u.test(text)) engine = "xelatex";
  else if (/graphdrawing/iu.test(text) || /\\usetikzlibrary\s*\{[^}]*graphdrawing[^}]*\}/isu.test(text)) engine = "lualatex";
  else if (/\\(?:special|dvips)/u.test(source)) engine = "latex";
  else engine = "pdflatex";

  const executable = ({ latex: settings.latexPath, pdflatex: settings.pdflatexPath, xelatex: settings.xelatexPath, lualatex: settings.lualatexPath, dvilualatex: settings.dvilualatexPath } as Record<Exclude<Engine, "auto">, string>)[engine];
  const outputType: EnginePlan["outputType"] = engine === "latex" || engine === "dvilualatex" ? "dvi" : engine === "xelatex" ? "xdv" : "pdf";
  return { engine, executable, outputType };
}

export function buildDocument(source: string, settings: TikzSettings, preambleOverride?: string): string {
  const body = source.trim();
  const effectivePreamble = preambleOverride ?? augmentPreamble(settings.preamble, source);
  const text = `${effectivePreamble}\n${body}`;
  const needsXe = /[\u0600-\u06ff]/u.test(text) || /\\usepackage\s*\{\s*(?:xepersian|fontspec)\s*\}/u.test(text);
  const needsXepersian = needsXe && !/\\usepackage\s*\{\s*xepersian\s*\}/u.test(effectivePreamble) && /[\u0600-\u06ff]/u.test(source);
  const language = needsXepersian ? `\\usepackage{xepersian}\n\\settextfont{${escapeTex(settings.persianFont)}}\n` : "";

  // A complete TeX document owns its own document environment. Preserve it,
  // but merge the resolver-generated preamble into its existing preamble.
  if (/^\\documentclass\b/u.test(body) && /\\begin\{document\}/u.test(body)) {
    const documentIndex = body.search(/\\begin\{document\}/u);
    const documentBody = body.slice(documentIndex);
    const ownPreamble = body.slice(0, documentIndex);
    const ownClass = ownPreamble.match(/^\\documentclass(?:\[[^\]]*\])?\{[^}]+\}\s*/u)?.[0] ?? "\\documentclass{standalone}\n";
    const rest = ownPreamble.slice(ownClass.length).trim();
    const merged = [ownClass.trimEnd(), effectivePreamble.trim(), rest, language.trim()].filter(Boolean).join("\n");
    return `${merged}\n${documentBody}\n`;
  }

  const hasPictureEnvironment = /\\begin\{(?:tikzpicture|circuitikz|pgfonlayer)\}/u.test(body);
  const hasStandalonePgfplotsEnvironment = /\\begin\{(?:axis|semilogxaxis|semilogyaxis|loglogaxis)\}/u.test(body);
  const hasDisplayMathEnvironment = /\\begin\{(?:equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|flalign\*?|split|cases|matrix\*?|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/u.test(body);
  const hasGeneralTexEnvironment = /\\begin\{(?:minipage|tabular|array|itemize|enumerate|description|verbatim|lstlisting|theorem|proof|quote|quotation|center|flushleft|flushright)\}/u.test(body);
  const hasTikzCommands = /(?:^|\n)\s*\\(?:draw|path|fill|filldraw|shade|shadedraw|clip|node|coordinate|matrix|pic|graph|foreach|spy|pattern|useasboundingbox)\b/u.test(body);

  let wrapper: string;
  if (hasPictureEnvironment || hasStandalonePgfplotsEnvironment || hasDisplayMathEnvironment || hasGeneralTexEnvironment) {
    wrapper = body;
  } else if (hasTikzCommands || /^\\(?:tikz|tikzset|usetikzlibrary|pgfkeys|pgfplotsset)\b/u.test(body)) {
    wrapper = `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
  } else {
    // The markdown block may be ordinary TeX/LaTeX. Do not force arbitrary
    // TeX environments into a tikzpicture; that corrupts grouping and causes
    // errors such as "Missing \\endgroup" at the end of gather/align.
    wrapper = body;
  }

  const documentClass = needsXe || hasDisplayMathEnvironment || hasGeneralTexEnvironment ? "article" : "standalone";
  return `\\documentclass{${documentClass}}\n${effectivePreamble}\n${language}\\begin{document}\n${wrapper}\n\\end{document}\n`;
}

export function compilerArgs(tex: string, work: string, outputType: EnginePlan["outputType"] = "pdf"): string[] {
  const common = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", "-output-directory", work];
  return outputType === "xdv" ? [...common, "-no-pdf", tex] : [...common, tex];
}

function resolveSiblingExecutable(configured: string, name: string): string {
  const value = configured.trim();
  if (!value) return name;
  if (path.isAbsolute(value)) return path.join(path.dirname(value), process.platform === "win32" ? `${name}.exe` : name);
  return name;
}

function escapeTex(value: string): string { return value.replace(/[{}%\\]/g, "\\$&"); }
function sanitizeSvg(svg: string): string { return svg.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, "").replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, ""); }
