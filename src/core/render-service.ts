import { App, normalizePath } from "obsidian";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { BlockKind, Engine, InstallationResult, RenderResult } from "./types";
import { TikzSettings } from "../settings/settings";

const execFileAsync = promisify(execFile);
const PIPELINE_VERSION = "3";
const MAX_OUTPUT = 4 * 1024 * 1024;

export class RenderError extends Error {
  constructor(message: string, readonly details = "") {
    super(message);
    this.name = "RenderError";
  }
}

interface EnginePlan {
  engine: Exclude<Engine, "auto">;
  executable: string;
  outputType: "pdf" | "dvi";
}

export class RenderService {
  private readonly inflight = new Map<string, Promise<RenderResult>>();
  private disposed = false;

  constructor(private readonly app: App, private readonly getSettings: () => TikzSettings) {}

  dispose(): void {
    this.disposed = true;
    this.inflight.clear();
  }

  async render(source: string, kind: BlockKind): Promise<RenderResult> {
    if (this.disposed) throw new RenderError("Renderer is shutting down.");
    const settings = this.getSettings();
    const plan = this.selectEngine(source, settings);
    const hash = this.hash(source, kind, plan, settings);
    const pending = this.inflight.get(hash);
    if (pending) return pending;

    const task = this.renderInternal(source, kind, plan, hash, settings);
    this.inflight.set(hash, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(hash);
    }
  }

  async clearCache(): Promise<void> {
    await fs.rm(this.cacheRoot(), { recursive: true, force: true });
  }

  async detectExecutables(): Promise<Partial<TikzSettings>> {
    const settings = this.getSettings();
    const pairs: Array<[keyof TikzSettings, string]> = [
      ["latexPath", "latex"], ["pdflatexPath", "pdflatex"], ["xelatexPath", "xelatex"],
      ["lualatexPath", "lualatex"], ["dvilualatexPath", "dvilualatex"], ["dvisvgmPath", "dvisvgm"],
      ["mutoolPath", "mutool"],
    ];
    const out: Partial<TikzSettings> = {};
    for (const [key, fallback] of pairs) {
      const current = String(settings[key]);
      if (await this.commandWorks(current)) {
        (out as Record<string, string>)[key] = current;
      } else if (await this.commandWorks(fallback)) {
        (out as Record<string, string>)[key] = fallback;
      }
    }
    return out;
  }

  async testInstallation(): Promise<InstallationResult> {
    const s = this.getSettings();
    const pairs: Array<[string, string]> = [
      ["latex", s.latexPath], ["pdflatex", s.pdflatexPath], ["xelatex", s.xelatexPath],
      ["lualatex", s.lualatexPath], ["dvilualatex", s.dvilualatexPath], ["dvisvgm", s.dvisvgmPath],
      ["mutool", s.mutoolPath],
    ];
    const results: Record<string, boolean> = {};
    for (const [name, executable] of pairs) results[name] = await this.commandWorks(executable);
    return {
      results,
      summary: pairs.map(([name]) => `${name}: ${results[name] ? "OK" : "FAILED"}`).join("\n"),
    };
  }

  private async renderInternal(source: string, kind: BlockKind, plan: EnginePlan, hash: string, settings: TikzSettings): Promise<RenderResult> {
    const cache = this.cacheRoot();
    const svgPath = path.join(cache, `${hash}.svg`);
    try {
      return { svg: await fs.readFile(svgPath, "utf8"), hash, engine: plan.engine, fromCache: true, source, kind };
    } catch {
      // Cache miss.
    }

    await fs.mkdir(cache, { recursive: true });
    const work = path.join(cache, `work-${hash}-${randomBytes(6).toString("hex")}`);
    await fs.mkdir(work, { recursive: true });
    const texPath = path.join(work, "main.tex");
    await fs.writeFile(texPath, this.buildDocument(source, settings), "utf8");

    try {
      await this.run(plan.executable, this.compilerArgs(texPath, work), work, settings.compileTimeout);
      const input = path.join(work, plan.outputType === "dvi" ? "main.dvi" : "main.pdf");
      const output = path.join(work, "main.svg");
      const args = [input, "-n", "-o", output];
      if (plan.outputType === "pdf") args.unshift("--pdf");
      await this.run(settings.dvisvgmPath, args, work, settings.compileTimeout);
      const svg = sanitizeSvg(await fs.readFile(output, "utf8"));
      await fs.writeFile(svgPath, svg, "utf8");
      return { svg, hash, engine: plan.engine, fromCache: false, source, kind };
    } catch (error) {
      const log = await this.readLog(work);
      console.error("[TikZ Renderer] rendering failed", { error, hash, plan, work, log });
      throw this.normalizeError(error, log);
    } finally {
      if (!settings.keepTexSource) await fs.rm(work, { recursive: true, force: true }).catch((error: unknown) => console.warn("[TikZ Renderer] temp cleanup failed", error));
    }
  }

  private buildDocument(source: string, settings: TikzSettings): string {
    const arabic = /[\u0600-\u06ff]/u.test(source);
    const needsXe = arabic || /\\usepackage\s*\{\s*(?:xepersian|fontspec)\s*\}/u.test(source);
    const language = needsXe ? `\\usepackage{xepersian}\n\\settextfont{${escapeTex(settings.persianFont)}}\n` : "";
    const body = source.trim();
    const alreadyDocument = /^\\documentclass\b/u.test(body) && /\\begin\{document\}/u.test(body);
    if (alreadyDocument) return body.endsWith("\n") ? body : `${body}\n`;

    const hasPictureEnvironment = /\\begin\{(?:tikzpicture|circuitikz|pgfonlayer|axis)\}/u.test(body);
    const wrapper = hasPictureEnvironment ? body : `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;

    return `\\documentclass{${needsXe ? "article" : "standalone"}}\n${settings.preamble}\n${language}\\begin{document}\n${wrapper}\n\\end{document}\n`;
  }

  private compilerArgs(tex: string, work: string): string[] {
    return ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", "-output-directory", work, tex];
  }

  private selectEngine(source: string, settings: TikzSettings): EnginePlan {
    let engine: Exclude<Engine, "auto">;
    if (settings.engine !== "auto") {
      engine = settings.engine;
    } else if (/\\usepackage\s*\{\s*(?:xepersian|fontspec)\s*\}|[\u0600-\u06ff]/u.test(source)) {
      engine = "xelatex";
    } else if (/graphdrawing/iu.test(source) || /\\usetikzlibrary\s*\{[^}]*graphs[^}]*graphdrawing/isu.test(source)) {
      engine = "lualatex";
    } else if (/\\(?:special|dvips)/u.test(source)) {
      engine = "latex";
    } else {
      engine = "pdflatex";
    }

    const executable = ({ latex: settings.latexPath, pdflatex: settings.pdflatexPath, xelatex: settings.xelatexPath, lualatex: settings.lualatexPath, dvilualatex: settings.dvilualatexPath } as Record<Exclude<Engine, "auto">, string>)[engine];
    return { engine, executable, outputType: engine === "latex" || engine === "dvilualatex" ? "dvi" : "pdf" };
  }

  private hash(source: string, kind: BlockKind, plan: EnginePlan, settings: TikzSettings): string {
    return createHash("sha256").update(JSON.stringify({ source, kind, engine: plan.engine, executable: plan.executable, outputType: plan.outputType, preamble: settings.preamble, font: settings.persianFont, dvisvgm: settings.dvisvgmPath, pipeline: PIPELINE_VERSION })).digest("hex");
  }

  private cacheRoot(): string {
    return path.join(this.app.vault.adapter.getBasePath(), normalizePath(this.getSettings().cacheFolder));
  }

  private async commandWorks(executable: string): Promise<boolean> {
    if (!executable.trim()) return false;
    try {
      await execFileAsync(executable, ["--version"], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
      return true;
    } catch {
      return false;
    }
  }

  private async run(executable: string, args: string[], cwd: string, timeout: number): Promise<void> {
    try {
      await execFileAsync(executable, args, { cwd, timeout, windowsHide: true, maxBuffer: MAX_OUTPUT });
    } catch (error) {
      const x = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
      if (x.code === "ENOENT") throw new RenderError(`Executable not found: ${executable}`, x.message);
      if (x.code === "ETIMEDOUT" || x.killed) throw new RenderError(`Process timed out after ${timeout} ms: ${executable}`, x.stderr ?? x.message);
      if (x.code === "EACCES") throw new RenderError(`Permission denied: ${executable}`, x.message);
      throw new RenderError(`Process failed: ${executable}`, [x.stderr, x.stdout, x.message].filter(Boolean).join("\n"));
    }
  }

  private async readLog(work: string): Promise<string> {
    try { return await fs.readFile(path.join(work, "main.log"), "utf8"); } catch { return "No TeX log was produced."; }
  }

  private normalizeError(error: unknown, log: string): RenderError {
    const base = error instanceof RenderError ? error : new RenderError("TeX/TikZ rendering failed", String(error));
    const detail = log.length > 30000 ? `${log.slice(-30000)}\n[log truncated]` : log;
    return new RenderError(`${base.message}\n\n--- TeX log ---\n${detail}`, base.details);
  }
}

function escapeTex(value: string): string {
  return value.replace(/[{}%\\]/g, "\\$&");
}

function sanitizeSvg(svg: string): string {
  return svg.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, "");
}
