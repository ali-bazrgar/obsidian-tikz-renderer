import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { TeXExecutableName, texLiveExecutableCandidates } from "./executable-detector";

const execFileAsync = promisify(execFile);

export interface TeXDependency {
  kind: "package" | "library";
  name: string;
  file: string;
}

export interface DependencyResolution {
  preamble: string;
  added: TeXDependency[];
  attempts: number;
}

/**
 * TeX Live is treated as the source of truth. kpsewhich resolves files using
 * the installed TeX Live tree, so the resolver never downloads or installs
 * anything. This is especially useful for a full TeX Live installation: a
 * dependency is added only to the block that actually needs it.
 */
export class TeXDependencyResolver {
  constructor(private readonly texLiveRoot: string, private readonly compilerPath: string) {}

  async resolve(basePreamble: string, source: string, initialPreamble: string, log?: string): Promise<DependencyResolution> {
    let preamble = initialPreamble;
    const added: TeXDependency[] = [];
    const seen = new Set<string>();
    let attempts = 0;

    // First pass: source-driven hints are already represented in initialPreamble.
    // Subsequent passes are driven by the actual TeX error log.
    const maxRounds = 6;
    let currentLog = log ?? "";
    while (attempts < maxRounds) {
      attempts += 1;
      const candidates = this.extractCandidates(source, currentLog);
      let changed = false;

      for (const candidate of candidates) {
        const key = `${candidate.kind}:${candidate.name}`;
        if (seen.has(key) || this.hasDependency(preamble, candidate)) continue;
        seen.add(key);

        if (!(await this.existsInTeXLive(candidate.file))) continue;

        if (candidate.kind === "package") {
          preamble = appendLine(preamble, `\\usepackage{${candidate.name}}`);
        } else {
          preamble = appendTikzLibrary(preamble, candidate.name);
        }
        added.push(candidate);
        changed = true;
      }

      // No log means this is only a preflight pass. If nothing was added,
      // return immediately rather than touching the compiler again.
      if (!currentLog || !changed) break;
      currentLog = "";
    }

    return { preamble, added, attempts };
  }

  async resolveFromLog(source: string, preamble: string, log: string): Promise<DependencyResolution> {
    return this.resolve(preamble, source, preamble, log);
  }

  private extractCandidates(source: string, log: string): TeXDependency[] {
    const candidates: TeXDependency[] = [];

    // Generic missing .sty: this covers packages that are not known to our
    // static detector. kpsewhich decides whether the file is actually present.
    for (const match of log.matchAll(/(?:File|file) [`']([^`']+\.sty)[`']\s+not found/giu)) {
      const file = match[1];
      const name = path.basename(file, ".sty");
      if (isSafeControlName(name)) candidates.push({ kind: "package", name, file });
    }

    // TikZ libraries are ordinary TeX files named tikzlibrary<name>.code.tex.
    for (const match of log.matchAll(/(?:File|file) [`'](tikzlibrary[^`']+\.code\.tex)[`']\s+not found/giu)) {
      const file = match[1];
      const name = file.slice("tikzlibrary".length, -".code.tex".length);
      if (isSafeLibraryName(name)) candidates.push({ kind: "library", name, file });
    }

    // A number of packages report missing environments rather than their
    // package file. Keep this table small and conservative; unknown errors are
    // left untouched instead of guessing and mutating the user's preamble.
    for (const match of log.matchAll(/Environment\s+([A-Za-z][A-Za-z0-9*_-]*)\s+undefined/gu)) {
      const environment = match[1];
      const mapped = ENVIRONMENT_PACKAGES[environment.replace(/\*$/, "")];
      if (mapped) candidates.push(mapped);
    }

    // The source is useful as a fallback when TeX reports an environment before
    // it reaches the package's own error message.
    for (const candidate of sourceHints(source)) candidates.push(candidate);

    return dedupe(candidates);
  }

  private async existsInTeXLive(file: string): Promise<boolean> {
    const kpsewhich = this.kpsewhichPath();
    try {
      const result = await execFileAsync(kpsewhich, ["--must-exist", file], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 256 * 1024,
      });
      return Boolean(result.stdout.trim());
    } catch {
      return false;
    }
  }

  private kpsewhichPath(): string {
    const root = this.texLiveRoot.trim();
    if (root) {
      const candidates = texLiveExecutableCandidates(root) as Partial<Record<TeXExecutableName, string>>;
      const compilerDir = this.compilerPath.includes("\\") || this.compilerPath.includes("/")
        ? path.dirname(this.compilerPath)
        : undefined;
      return candidates.latex
        ? path.join(path.dirname(candidates.latex), process.platform === "win32" ? "kpsewhich.exe" : "kpsewhich")
        : compilerDir
          ? path.join(compilerDir, process.platform === "win32" ? "kpsewhich.exe" : "kpsewhich")
          : process.platform === "win32" ? "kpsewhich.exe" : "kpsewhich";
    }

    const compilerDir = this.compilerPath.includes("\\") || this.compilerPath.includes("/")
      ? path.dirname(this.compilerPath)
      : undefined;
    return compilerDir
      ? path.join(compilerDir, process.platform === "win32" ? "kpsewhich.exe" : "kpsewhich")
      : process.platform === "win32" ? "kpsewhich.exe" : "kpsewhich";
  }

  private hasDependency(preamble: string, candidate: TeXDependency): boolean {
    const escaped = escapeRegExp(candidate.name);
    if (candidate.kind === "package") {
      return new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "u").test(preamble);
    }
    return new RegExp(`\\\\usetikzlibrary\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "u").test(preamble);
  }
}

const ENVIRONMENT_PACKAGES: Record<string, TeXDependency> = {
  axis: { kind: "package", name: "pgfplots", file: "pgfplots.sty" },
  semilogxaxis: { kind: "package", name: "pgfplots", file: "pgfplots.sty" },
  semilogyaxis: { kind: "package", name: "pgfplots", file: "pgfplots.sty" },
  loglogaxis: { kind: "package", name: "pgfplots", file: "pgfplots.sty" },
  tikzcd: { kind: "package", name: "tikz-cd", file: "tikz-cd.sty" },
  circuitikz: { kind: "package", name: "circuitikz", file: "circuitikz.sty" },
  forest: { kind: "package", name: "forest", file: "forest.sty" },
};

function sourceHints(source: string): TeXDependency[] {
  const result: TeXDependency[] = [];
  if (/\\begin\{axis\}|\\addplot\b|\\addplot3\b/u.test(source)) result.push(ENVIRONMENT_PACKAGES.axis);
  if (/\\begin\{tikzcd\}/u.test(source)) result.push(ENVIRONMENT_PACKAGES.tikzcd);
  if (/\\begin\{circuitikz\}/u.test(source)) result.push(ENVIRONMENT_PACKAGES.circuitikz);
  if (/\\begin\{forest\}|\\forestset\b/u.test(source)) result.push(ENVIRONMENT_PACKAGES.forest);
  return result;
}

function appendLine(preamble: string, line: string): string {
  return `${preamble.trimEnd()}\n${line}\n`;
}

function appendTikzLibrary(preamble: string, library: string): string {
  const match = preamble.match(/\\usetikzlibrary\{([^}]*)\}/u);
  if (!match) return appendLine(preamble, `\\usetikzlibrary{${library}}`);
  const existing = match[1].split(",").map((x) => x.trim()).filter(Boolean);
  if (existing.includes(library)) return preamble;
  return preamble.replace(match[0], `\\usetikzlibrary{${[...existing, library].join(",")}}`);
}

function dedupe(items: TeXDependency[]): TeXDependency[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSafeControlName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value) && value.length <= 80;
}

function isSafeLibraryName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(value) && value.length <= 100;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
