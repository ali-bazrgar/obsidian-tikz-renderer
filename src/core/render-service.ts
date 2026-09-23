import { App, FileSystemAdapter, normalizePath } from "obsidian";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Engine, TikzSettings } from "../settings/settings";
import { BlockKind, EnginePlan, RenderResult } from "./types";
import { ConcurrencyLimiter } from "./concurrency";
import { probeAllExecutables, TeXExecutableName, texLiveExecutableCandidates } from "./executable-detector";
import { augmentPreamble } from "./tex-package-detector";
import { TeXDependencyResolver, TeXDependency } from "./tex-dependency-resolver";

const execFileAsync = promisify(execFile);
const PIPELINE_VERSION = "15-robust-font-deps-xelatex-pdf-preview-fences";
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_DEPENDENCY_FILES = 200;
const MAX_DEPENDENCY_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_DEPENDENCY_FILE_BYTES = 50 * 1024 * 1024;

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  timedOut?: boolean;
}

interface ExternalDependency {
  vaultPath: string;
  stagedPath: string;
  bytes: Buffer;
  text?: string;
  digest: string;
  isText: boolean;
}

interface PreparedExternalDependencies {
  files: ExternalDependency[];
  fingerprint: Array<{ path: string; digest: string }>;
}

interface CompileContext {
  source: string;
  kind: BlockKind;
  sourcePath?: string;
  fullDocument: boolean;
  effectivePreamble: string;
  external: PreparedExternalDependencies;
}

export class RenderError extends Error {
  constructor(message: string, readonly details?: string) { super(message); this.name = "RenderError"; }
}

export class RenderService {
  private readonly inFlight = new Map<string, Promise<RenderResult>>();
  private readonly limiter = new ConcurrencyLimiter(2);
  private readonly fontProbeCache = new Map<string, { ok: boolean; error?: string }>();

  constructor(private readonly app: App, private readonly getSettings: () => TikzSettings) {}
  dispose(): void { this.inFlight.clear(); this.fontProbeCache.clear(); }

  async render(source: string, kind: BlockKind, sourcePath?: string): Promise<RenderResult> {
    const settings = this.getSettings();
    const external = await this.prepareExternalDependencies(source, sourcePath);
    const detectionSource = [source, ...external.files.map(file => file.text ?? "")].join("\n");
    const plan = selectEngine(detectionSource, settings);
    if (plan.engine === "dvilualatex") {
      throw new RenderError("dvilualatex is not a compatible SVG backend because dvisvgm does not support LuaTeX's extended DVI font references. Use lualatex (PDF) or xelatex instead.");
    }

    const hash = this.hash(source, kind, plan, settings, external.fingerprint, sourcePath);
    const existing = this.inFlight.get(hash);
    if (existing) return existing;
    const task = this.limiter.run(() => this.renderUnique(source, kind, plan, hash, settings, sourcePath, external));
    this.inFlight.set(hash, task);
    try { return await task; } finally { this.inFlight.delete(hash); }
  }

  async testPersianFont(): Promise<{ ok: boolean; message: string }> {
    const settings = this.getSettings();
    try {
      const font = getPersianFontSelection(settings);
      if (!font) return { ok: false, message: "No Persian font family or font file is configured." };
      const plan: EnginePlan = { engine: "xelatex", executable: settings.xelatexPath, outputType: "pdf" };
      await this.validateConfiguredFontIfNeeded("سلام", settings, plan, true);
      return { ok: true, message: "Persian font is available: " + font.value + (font.path ? " (" + font.path + ")" : "") };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  async clearCache(): Promise<void> { await fs.rm(this.cacheRoot(), { recursive: true, force: true }); }

  async testInstallation(): Promise<{ summary: string; results: Awaited<ReturnType<typeof probeAllExecutables>> }> {
    const settings = this.getSettings();
    const results = await probeAllExecutables({
      latex: settings.latexPath, pdflatex: settings.pdflatexPath, xelatex: settings.xelatexPath,
      lualatex: settings.lualatexPath, dvilualatex: settings.dvilualatexPath,
      dvisvgm: settings.dvisvgmPath, mutool: settings.mutoolPath,
    });
    return { summary: results.map((x) => `${x.name}: ${x.ok ? "OK" : "FAILED"}`).join("\n"), results };
  }

  async detectExecutables(): Promise<Partial<TikzSettings>> {
    const settings = this.getSettings();
    const fromRoot = texLiveExecutableCandidates(settings.texLiveRoot);
    const configured = {
      latex: fromRoot.latex ?? settings.latexPath, pdflatex: fromRoot.pdflatex ?? settings.pdflatexPath,
      xelatex: fromRoot.xelatex ?? settings.xelatexPath, lualatex: fromRoot.lualatex ?? settings.lualatexPath,
      dvilualatex: fromRoot.dvilualatex ?? settings.dvilualatexPath, dvisvgm: fromRoot.dvisvgm ?? settings.dvisvgmPath,
      mutool: fromRoot.mutool ?? settings.mutoolPath,
    } satisfies Partial<Record<TeXExecutableName, string>>;
    const results = await probeAllExecutables(configured);
    const output: Partial<TikzSettings> = {};
    for (const result of results) {
      if (!result.ok) continue;
      (output as Record<string, unknown>)[`${result.name}Path`] = result.configuredPath;
    }
    return output;
  }

  private async renderUnique(
    source: string,
    kind: BlockKind,
    plan: EnginePlan,
    hash: string,
    settings: TikzSettings,
    sourcePath: string | undefined,
    external: PreparedExternalDependencies,
  ): Promise<RenderResult> {
    const cache = this.cacheRoot();
    const cached = path.join(cache, `${hash}.svg`);
    if (await this.exists(cached)) return { hash, svg: await fs.readFile(cached, "utf8"), engine: plan.engine, fromCache: true, source, kind };

    const work = path.join(cache, `work-${hash}-${Math.random().toString(36).slice(2, 10)}`);
    await fs.mkdir(cache, { recursive: true });
    await fs.mkdir(work, { recursive: true });

    let lastCompileDetails = "";
    try {
      await this.stageExternalDependencies(external.files, work);

      const fullDocument = isFullDocument(source);
      const basePreamble = fullDocument
        ? augmentPreamble(extractDocumentPreamble(source), source)
        : augmentPreamble(settings.preamble, source);
      const compilationSource = normalizeLatexSource(rewriteExternalReferences(source, sourcePath, external.files));
      const detectionSource = [compilationSource, ...external.files.map(file => file.text ?? "")].join("\n");
      const resolver = new TeXDependencyResolver(settings.texLiveRoot, plan.executable);
      let effectivePreamble = basePreamble;
      let dependencyAttempts = 0;
      let bestEffortWarning: string | undefined;

      await this.validateConfiguredFontIfNeeded(source, settings, plan);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        dependencyAttempts += 1;
        const document = buildDocument(compilationSource, settings, kind, effectivePreamble, plan.engine === "xelatex", detectionSource);
        await fs.writeFile(path.join(work, "main.tex"), document, "utf8");

        const compile = await this.runCompiler(plan.executable, compilerArgs("main.tex", work, plan.outputType, settings.shellEscape), work, settings.compileTimeout, sourcePath, external.files);
        const log = await this.readLog(work);
        lastCompileDetails = [compile.stderr, compile.stdout, log].filter(Boolean).join("\n");

        const extension = plan.outputType === "pdf" ? "pdf" : plan.outputType === "xdv" ? "xdv" : "dvi";
        const input = path.join(work, `main.${extension}`);
        const artifactExists = await this.exists(input);

        if (compile.ok) {
          const svg = await this.convertToSvg(input, plan.outputType, work, settings);
          await fs.writeFile(cached, svg, "utf8");
          return { hash, svg, engine: plan.engine, fromCache: false, source, kind };
        }

        const resolved = await resolver.resolveFromLog(source, effectivePreamble, log);
        if (resolved.added.length > 0 && resolved.preamble !== effectivePreamble && attempt < 3) {
          effectivePreamble = resolved.preamble;
          continue;
        }

        if (settings.bestEffortOutput && artifactExists) {
          try {
            const svg = await this.convertToSvg(input, plan.outputType, work, settings);
            await fs.writeFile(cached, svg, "utf8");
            bestEffortWarning = `TeX exited with code ${compile.exitCode ?? "non-zero"}, but a valid ${extension.toUpperCase()} artifact was produced and converted successfully.`;
            return { hash, svg, engine: plan.engine, fromCache: false, source, kind, warning: bestEffortWarning };
          } catch (conversionError) {
            lastCompileDetails = [lastCompileDetails, conversionError instanceof Error ? conversionError.message : String(conversionError)].filter(Boolean).join("\n");
          }
        }

        break;
      }

      throw new RenderError("TeX/TikZ rendering failed", lastCompileDetails || "No TeX diagnostics were produced.");
    } catch (error) {
      throw this.normalizeError(error, await this.readLog(work));
    } finally {
      if (!settings.keepTexSource) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async validateConfiguredFontIfNeeded(source: string, settings: TikzSettings, plan: EnginePlan, force = false): Promise<void> {
    if (plan.engine !== "xelatex" || (!force && !/[\u0600-\u06ff]/u.test(source))) return;
    if (!force && /\\(?:settextfont|setlatintextfont|setmainfont|newfontfamily)\b/u.test(settings.preamble + "\n" + source)) return;
    const font = getPersianFontSelection(settings);
    if (!font) return;
    const key = [plan.executable, font.value, font.path ?? ""].join("\n");
    const cached = this.fontProbeCache.get(key);
    if (cached?.ok) return;
    if (font.path) {
      const stat = await fs.stat(font.path).catch(() => undefined);
      if (!stat?.isFile()) throw new RenderError("Configured Persian font file does not exist: " + font.path);
    }
    const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "tikz-font-probe-"));
    try {
      const probe = [
        "\\documentclass{article}",
        "\\usepackage{xepersian}",
        font.command,
        "\\begin{document}",
        "سلام",
        "\\end{document}",
        "",
      ].join("\n");
      await fs.writeFile(path.join(probeDir, "probe.tex"), probe, "utf8");
      const result = await this.runCompiler(plan.executable, ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", "-output-directory", probeDir, "probe.tex"], probeDir, settings.compileTimeout);
      if (!result.ok || !await this.exists(path.join(probeDir, "probe.pdf"))) {
        const detail = [result.stderr, result.stdout, await this.readNamedLog(probeDir, "probe")].filter(Boolean).join("\n");
        throw new RenderError("Configured Persian font " + font.value + " is not available to XeLaTeX. Check the exact family name or font file path.\n\n" + detail);
      }
      this.fontProbeCache.set(key, { ok: true });
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  private async convertToSvg(input: string, outputType: EnginePlan["outputType"], work: string, settings: TikzSettings): Promise<string> {
    const output = path.join(work, "main.svg");
    if (outputType === "pdf") {
      const mutool = settings.mutoolPath.trim() || "mutool";
      await this.runStrict(mutool, ["draw", "-q", "-F", "svg", "-o", output, input, "1"], work, settings.compileTimeout);
    } else {
      await this.runStrict(settings.dvisvgmPath, ["--no-fonts", "--exact-bbox", "--embed-bitmaps", input, "-o", output], work, settings.compileTimeout);
    }
    if (!await this.exists(output)) throw new RenderError("The vector converter completed without producing an SVG file.");
    return sanitizeSvg(await fs.readFile(output, "utf8"));
  }

  private hash(source: string, kind: BlockKind, plan: EnginePlan, settings: TikzSettings, fingerprint: Array<{ path: string; digest: string }>, sourcePath?: string): string {
    return createHash("sha256")
      .update(JSON.stringify({
        source,
        kind,
        sourcePath: sourcePath ?? "",
        engine: plan.engine,
        executable: plan.executable,
        outputType: plan.outputType,
        preamble: augmentPreamble(settings.preamble, source),
        font: settings.persianFont,
        fontPath: settings.persianFontPath,
        dvisvgm: settings.dvisvgmPath,
        mutool: settings.mutoolPath,
        shellEscape: settings.shellEscape,
        bestEffortOutput: settings.bestEffortOutput,
        external: fingerprint,
        pipeline: PIPELINE_VERSION,
      }))
      .digest("hex");
  }

  private cacheRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new RenderError("TikZ Renderer requires Obsidian Desktop with a filesystem-backed vault.");
    return path.join(adapter.getBasePath(), normalizePath(this.getSettings().cacheFolder));
  }

  private async runCompiler(executable: string, args: string[], cwd: string, timeout: number, sourcePath?: string, externalFiles: ExternalDependency[] = []): Promise<CommandResult> {
    try {
      const env = buildTeXEnvironment(cwd, sourcePath, externalFiles, this.app);
      const result = await execFileAsync(executable, args, { cwd, env, timeout, windowsHide: true, maxBuffer: MAX_OUTPUT });
      return { ok: true, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: 0 };
    } catch (error) {
      const x = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string; code?: string | number };
      if (x.code === "ENOENT") throw new RenderError(`Executable not found: ${executable}`, x.message);
      if (x.code === "EACCES") throw new RenderError(`Permission denied: ${executable}`, x.message);
      return {
        ok: false,
        stdout: String(x.stdout ?? ""),
        stderr: String(x.stderr ?? ""),
        exitCode: typeof x.code === "number" ? x.code : undefined,
        timedOut: x.code === "ETIMEDOUT" || x.killed,
      };
    }
  }

  private async runStrict(executable: string, args: string[], cwd: string, timeout: number): Promise<void> {
    try {
      await execFileAsync(executable, args, { cwd, timeout, windowsHide: true, maxBuffer: MAX_OUTPUT, env: buildTeXEnvironment(cwd, undefined, [], this.app) });
    } catch (error) {
      const x = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
      if (x.code === "ENOENT") throw new RenderError(`Executable not found: ${executable}`, x.message);
      if (x.code === "ETIMEDOUT" || x.killed) throw new RenderError(`Process timed out after ${timeout} ms: ${executable}`, x.stderr ?? x.message);
      if (x.code === "EACCES") throw new RenderError(`Permission denied: ${executable}`, x.message);
      throw new RenderError(`Process failed: ${executable}`, [x.stderr, x.stdout, x.message].filter(Boolean).join("\n"));
    }
  }

  private async stageExternalDependencies(files: ExternalDependency[], work: string): Promise<void> {
    for (const file of files) {
      const destination = path.join(work, file.stagedPath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (file.text !== undefined) {
        const rewritten = rewriteStagedText(file.text, file.vaultPath, file.stagedPath, files);
        await fs.writeFile(destination, rewritten, "utf8");
      } else {
        await fs.writeFile(destination, file.bytes);
      }
    }
  }

  private async prepareExternalDependencies(source: string, sourcePath?: string): Promise<PreparedExternalDependencies> {
    if (!sourcePath) return { files: [], fingerprint: [] };
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return { files: [], fingerprint: [] };
    const vaultRoot = adapter.getBasePath();
    const sourceVaultPath = normalizeVaultPath(sourcePath);
    const sourceDir = path.posix.dirname(sourceVaultPath);
    const queue: Array<{ vaultPath: string; content: string; stagedPath: string }> = [];
    const files = new Map<string, ExternalDependency>();

    for (const ref of extractExternalReferences(source)) {
      const resolved = await resolveVaultFile(vaultRoot, sourceDir, ref.value, ref.kind);
      if (!resolved) continue;
      const key = resolved.vaultPath.toLowerCase();
      if (files.has(key)) continue;
      const dependency = await readExternalDependency(vaultRoot, resolved.vaultPath, stagedExternalPath(resolved.vaultPath));
      if (!dependency) continue;
      files.set(key, dependency);
      if (dependency.isText && dependency.text !== undefined && isTexLikeFile(dependency.vaultPath)) {
        queue.push({ vaultPath: dependency.vaultPath, content: dependency.text, stagedPath: dependency.stagedPath });
      }
    }

    let totalBytes = [...files.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
    if (totalBytes > MAX_DEPENDENCY_TOTAL_BYTES) throw new RenderError("Referenced LaTeX assets exceed the renderer's dependency staging limit.");
    let index = 0;
    while (index < queue.length && files.size < MAX_DEPENDENCY_FILES) {
      const current = queue[index++];
      for (const ref of extractExternalReferences(current.content)) {
        const resolved = await resolveVaultFile(vaultRoot, path.posix.dirname(current.vaultPath), ref.value, ref.kind);
        if (!resolved) continue;
        const key = resolved.vaultPath.toLowerCase();
        if (files.has(key)) continue;
        const dependency = await readExternalDependency(vaultRoot, resolved.vaultPath, stagedExternalPath(resolved.vaultPath));
        if (!dependency) continue;
        totalBytes += dependency.bytes.byteLength;
        if (dependency.bytes.byteLength > MAX_DEPENDENCY_FILE_BYTES || totalBytes > MAX_DEPENDENCY_TOTAL_BYTES) {
          throw new RenderError("Referenced LaTeX assets exceed the renderer's dependency staging limit.");
        }
        files.set(key, dependency);
        if (dependency.isText && dependency.text !== undefined && isTexLikeFile(dependency.vaultPath)) queue.push({ vaultPath: dependency.vaultPath, content: dependency.text, stagedPath: dependency.stagedPath });
      }
    }

    return {
      files: [...files.values()],
      fingerprint: [...files.values()].map(item => ({ path: item.vaultPath, digest: item.digest })).sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  private async exists(file: string): Promise<boolean> { return fs.stat(file).then((s) => s.isFile()).catch(() => false); }
  private async readLog(work: string): Promise<string> { return this.readNamedLog(work, "main"); }
  private async readNamedLog(work: string, basename: string): Promise<string> { try { return await fs.readFile(path.join(work, `${basename}.log`), "utf8"); } catch { return "No TeX log was produced."; } }

  private normalizeError(error: unknown, log: string): RenderError {
    const base = error instanceof RenderError ? error : new RenderError("TeX/TikZ rendering failed", String(error));
    const detail = log.length > 30000 ? `${log.slice(-30000)}\n[log truncated]` : log;
    return new RenderError(`${base.message}\n\n--- TeX log ---\n${detail}`, base.details);
  }
}

export function selectEngine(source: string, settings: TikzSettings): EnginePlan {
  let engine: Exclude<Engine, "auto">;
  const text = `${settings.preamble}\n${source}`;
  if (settings.engine !== "auto") engine = settings.engine;
  else if (/\\usepackage\s*\{\s*(?:xepersian|fontspec)\s*\}|[\u0600-\u06ff]/u.test(text)) engine = "xelatex";
  else if (/graphdrawing/iu.test(text) || /\\usetikzlibrary\s*\{[^}]*graphdrawing[^}]*\}/isu.test(text)) engine = "lualatex";
  else if (/\\(?:special|dvips)/u.test(source)) engine = "latex";
  else engine = "latex";

  const executable = ({ latex: settings.latexPath, pdflatex: settings.pdflatexPath, xelatex: settings.xelatexPath, lualatex: settings.lualatexPath, dvilualatex: settings.dvilualatexPath } as Record<Exclude<Engine, "auto">, string>)[engine];
  const outputType: EnginePlan["outputType"] = engine === "latex" ? "dvi" : "pdf";
  return { engine, executable, outputType };
}

interface PersianFontSelection {
  value: string;
  path?: string;
  command: string;
}

function getPersianFontSelection(settings: TikzSettings): PersianFontSelection | undefined {
  const explicitPath = settings.persianFontPath.trim();
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    const slashPath = resolved.replace(/\\/gu, "/");
    const filename = path.posix.basename(slashPath);
    const directory = path.posix.dirname(slashPath);
    if (!/\.(?:ttf|otf|ttc)$/iu.test(filename)) throw new RenderError("Persian font file must be a .ttf, .otf or .ttc file.");
    const pathOption = directory && directory !== "."
      ? "[Path={" + escapeTex(directory.endsWith("/") ? directory : directory + "/") + "}]"
      : "";
    return { value: filename, path: resolved, command: "\\settextfont" + pathOption + "{" + escapeTex(filename) + "}" };
  }
  const family = settings.persianFont.trim();
  if (!family) return undefined;
  return { value: family, command: "\\settextfont{" + escapeTex(family) + "}" };
}
export function buildDocument(source: string, settings: TikzSettings, kind: BlockKind = "tikz", effectivePreamble = augmentPreamble(settings.preamble, source), forceXe = false, detectionSource = source): string {
  const body = source.trim();
  const detectionText = `${effectivePreamble}\n${detectionSource}`;
  const needsXe = forceXe || /[\u0600-\u06ff]/u.test(detectionText) || /\\usepackage\s*\{\s*(?:xepersian|fontspec)\s*\}/u.test(detectionText);
  const hasArabicText = /[\u0600-\u06ff]/u.test(detectionText);
  const explicitFontSelection = /\\(?:settextfont|setlatintextfont|setmainfont|newfontfamily)\b/u.test(detectionText);
  const configuredFont = getPersianFontSelection(settings);
  const language = needsXe && hasArabicText && !/\\usepackage\s*\{\s*xepersian\s*\}/u.test(effectivePreamble) && !explicitFontSelection
    ? configuredFont?.command
      ? `\\usepackage{xepersian}\n${configuredFont.command}\n`
      : "\\usepackage{xepersian}\n"
    : "";  const finalPreamble = language ? `${effectivePreamble.trimEnd()}\n${language}` : effectivePreamble;
  if (isFullDocument(body)) return buildFullDocument(body, finalPreamble);

  const wrapped = wrapGraphicBody(body, kind);
  const documentClass = "standalone";
  return `\\documentclass{${documentClass}}\n${finalPreamble}\n\\begin{document}\n${wrapped}\n\\end{document}\n`;
}

export function compilerArgs(tex: string, work: string, outputType: EnginePlan["outputType"] = "pdf", shellEscape: TikzSettings["shellEscape"] = "disabled"): string[] {
  const shell = shellEscape === "enabled" ? "-shell-escape" : shellEscape === "restricted" ? "-shell-restricted" : "-no-shell-escape";
  const common = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-synctex=0", shell, "-output-directory", work];
  return outputType === "xdv" ? [...common, "-no-pdf", tex] : [...common, tex];
}

function normalizeLatexSource(source: string): string {
  return source.replace(/^([ \t]*)\[[ \t]*\r?\n([\s\S]*?)\r?\n\\1\][ \t]*$/gmu, (whole, indent: string, inner: string) => {
    if (!/(?:\\\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|lim|left|right|text|mathrm|mathbf|operatorname|begin\\{|end\\{)|[_^]|[=<>])/.test(inner)) return whole;
    return indent + "\\[\n" + inner + "\n" + indent + "\\]";
  });
}

function wrapGraphicBody(body: string, kind: BlockKind): string {
  if (kind === "tex" || kind === "latex") return body;
  if (/\\begin\{tikzpicture\}/u.test(body)) return body;
  if (kind === "circuitikz") return /\\begin\{circuitikz\}/u.test(body) ? body : `\\begin{circuitikz}\n${body}\n\\end{circuitikz}`;
  if (/\\begin\{(?:forest|tikzcd)\}/u.test(body)) return body;
  if (/\\begin\{axis\}/u.test(body)) return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
  if (/\\begin\{pgfonlayer\}/u.test(body)) return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
  return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
}

function isFullDocument(source: string): boolean { return /^\\documentclass\b/u.test(source.trim()) && /\\begin\{document\}/u.test(source); }

function extractDocumentPreamble(source: string): string {
  const text = source.trim();
  const begin = text.search(/\\begin\{document\}/u);
  if (begin < 0) return "";
  const classMatch = /^\\documentclass(?:\[[^\]]*\])?\{[^}]+\}\s*/u.exec(text);
  const start = classMatch ? classMatch[0].length : 0;
  return text.slice(start, begin).trim();
}

function buildFullDocument(body: string, effectivePreamble: string): string {
  const current = extractDocumentPreamble(body);
  if (current.trim() === effectivePreamble.trim()) return body.endsWith("\n") ? body : body + "\n";
  const begin = body.search(/\\begin\{document\}/u);
  const classMatch = /^\\documentclass(?:\[[^\]]*\])?\{[^}]+\}\s*/u.exec(body);
  const start = classMatch ? classMatch[0].length : 0;
  const preamble = effectivePreamble.trim();
  return body.slice(0, start) + (preamble ? preamble + "\n" : "") + body.slice(begin);
}

function rewriteExternalReferences(source: string, sourcePath: string | undefined, files: ExternalDependency[]): string {
  if (!sourcePath || files.length === 0) return source;
  return rewriteReferenceCommands(source, normalizeVaultPath(sourcePath), "main.tex", files);
}

function rewriteStagedText(source: string, currentVaultPath: string, currentStagedPath: string, files: ExternalDependency[]): string {
  return rewriteReferenceCommands(source, normalizeVaultPath(currentVaultPath), currentStagedPath, files);
}

function rewriteReferenceCommands(source: string, currentVaultPath: string, currentStagedPath: string, files: ExternalDependency[]): string {
  let result = source;
  const replace = (regex: RegExp, kind: ExternalReference["kind"]): void => {
    result = result.replace(regex, (whole: string, reference: string) => {
      const dependency = findPreparedDependency(currentVaultPath, reference, kind, files);
      if (!dependency) return whole;
      return whole.replace(reference, relativeStagedPath(currentStagedPath, dependency.stagedPath));
    });
  };
  replace(/\\(?:input|subfile)\s*\{([^}]+)\}/gu, "input");
  replace(/\\include\s*\{([^}]+)\}/gu, "include");
  replace(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu, "graphics");
  replace(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu, "bib");
  replace(/\\bibliography\s*\{([^}]+)\}/gu, "bib");
  replace(/\\lstinputlisting(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu, "input");
  return result;
}

function findPreparedDependency(currentVaultPath: string, reference: string, kind: ExternalReference["kind"], files: ExternalDependency[]): ExternalDependency | undefined {
  const clean = reference.trim().replace(/^["']|["']$/gu, "").replace(/\\ /gu, " ").replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!clean || kind === "package" || clean.includes("\0")) return undefined;
  const names = [clean];
  if (kind === "graphics" && !path.posix.extname(clean)) {
    for (const ext of [".png", ".jpg", ".jpeg", ".pdf", ".eps", ".bmp"]) names.push(clean + ext);
  }
  if ((kind === "input" || kind === "include") && !path.posix.extname(clean)) names.push(clean + ".tex");
  if (kind === "bib" && !path.posix.extname(clean)) names.push(clean + ".bib");
  for (const name of names) {
    const absolute = path.posix.normalize(path.posix.isAbsolute(name) ? name.replace(/^\/+/, "") : path.posix.join(path.posix.dirname(currentVaultPath), name));
    const normalized = normalizeVaultPath(absolute);
    const match = files.find(file => file.vaultPath.toLowerCase() === normalized.toLowerCase());
    if (match) return match;
  }
  return undefined;
}

function relativeStagedPath(currentStagedPath: string, targetStagedPath: string): string {
  const current = currentStagedPath.replace(/\\/gu, "/");
  const target = targetStagedPath.replace(/\\/gu, "/");
  const relative = path.posix.relative(path.posix.dirname(current), target);
  return (relative || path.posix.basename(target)).replace(/\\/gu, "/");
}

function escapeTex(value: string): string { return value.replace(/[{}%\\]/g, "\\$&"); }

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

interface ExternalReference { kind: "input" | "include" | "graphics" | "bib" | "package"; value: string; }

function extractExternalReferences(source: string): ExternalReference[] {
  const result: ExternalReference[] = [];
  const add = (kind: ExternalReference["kind"], regex: RegExp) => {
    for (const match of source.matchAll(regex)) {
      const value = String(match[1] ?? "").trim();
      if (value) result.push({ kind, value });
    }
  };
  add("input", /\\(?:input|subfile)\s*\{([^}]+)\}/gu);
  add("include", /\\include\s*\{([^}]+)\}/gu);
  add("graphics", /\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu);
  add("bib", /\\(?:addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu);
  add("bib", /\\bibliography\s*\{([^}]+)\}/gu);
  add("input", /\\lstinputlisting(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu);
  add("package", /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/gu);
  add("package", /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/gu);
  return result.map(item => ({ ...item, value: item.value.replace(/\\ /gu, " ") }));
}

function isTexLikeFile(vaultPath: string): boolean {
  return /\.(?:tex|sty|cls|bib|cfg|def)$/iu.test(vaultPath);
}

function stagedExternalPath(vaultPath: string): string {
  return path.join("__vault__", ...vaultPath.split("/"));
}

async function readExternalDependency(vaultRoot: string, vaultPath: string, stagedPath: string): Promise<ExternalDependency | undefined> {
  const absolute = path.join(vaultRoot, ...vaultPath.split("/"));
  const stat = await fs.stat(absolute).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  if (stat.size > MAX_DEPENDENCY_FILE_BYTES) throw new RenderError(`Referenced file is too large to stage: ${vaultPath}`);
  const bytes = await fs.readFile(absolute);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const isText = isTexLikeFile(vaultPath);
  const text = isText ? bytes.toString("utf8") : undefined;
  return { vaultPath, stagedPath, bytes, text, digest, isText };
}

async function resolveVaultFile(vaultRoot: string, baseDir: string, reference: string, kind: ExternalReference["kind"]): Promise<{ vaultPath: string } | undefined> {
  const clean = reference
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "");
  if (!clean || clean.includes("\0")) return undefined;

  const candidateNames: string[] = [clean];
  if (kind === "graphics" && !path.posix.extname(clean)) {
    for (const ext of [".png", ".jpg", ".jpeg", ".pdf", ".eps", ".bmp"]) candidateNames.push(`${clean}${ext}`);
  }
  if ((kind === "input" || kind === "include") && !path.posix.extname(clean)) candidateNames.push(`${clean}.tex`);
  if (kind === "bib" && !path.posix.extname(clean)) candidateNames.push(`${clean}.bib`);
  if (kind === "package" && !path.posix.extname(clean)) candidateNames.push(`${clean}.sty`);

  const normalizedRoot = path.resolve(vaultRoot);
  for (const name of candidateNames) {
    const absolute = path.isAbsolute(name) ? path.resolve(name) : path.resolve(vaultRoot, ...path.posix.normalize(path.posix.join(baseDir, name)).split("/"));
    const relative = path.relative(normalizedRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const vaultPath = normalizeVaultPath(relative);
    if (await fs.stat(absolute).then(s => s.isFile()).catch(() => false)) return { vaultPath };
  }
  return undefined;
}

function normalizeVaultPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").split("/").filter(Boolean).join("/");
}

function buildTeXEnvironment(cwd: string, sourcePath: string | undefined, externalFiles: ExternalDependency[], app: App): NodeJS.ProcessEnv {
  const dirs = new Set<string>([cwd]);
  for (const file of externalFiles) dirs.add(path.dirname(path.join(cwd, file.stagedPath)));
  if (sourcePath) {
    const adapter = app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      const root = adapter.getBasePath();
      dirs.add(path.join(root, path.dirname(normalizeVaultPath(sourcePath))));
    }
  }
  const search = [...dirs].join(path.delimiter);
  const env = { ...process.env };
  env.TEXINPUTS = appendSearchPath(env.TEXINPUTS, search);
  env.BIBINPUTS = appendSearchPath(env.BIBINPUTS, search);
  env.BSTINPUTS = appendSearchPath(env.BSTINPUTS, search);
  env.TEXPICTS = appendSearchPath(env.TEXPICTS, search);
  return env;
}

function appendSearchPath(existing: string | undefined, value: string): string {
  return existing ? `${value}${path.delimiter}${existing}` : `${value}${path.delimiter}`;
}


function stripMarkdownFences(source: string): string {
  return source.replace(/^\s*```(?:tikz|pgfplots|circuitikz|tex|latex)?\s*$/gmu, "").trim();
}
