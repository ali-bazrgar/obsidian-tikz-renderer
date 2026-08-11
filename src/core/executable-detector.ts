import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { promises as fs } from "node:fs";

const execFileAsync = promisify(execFile);

export interface ExecutableProbe {
  name: string;
  configuredPath: string;
  resolvedPath?: string;
  version?: string;
  ok: boolean;
  error?: string;
}

const NAMES = ["latex", "pdflatex", "xelatex", "lualatex", "dvilualatex", "dvisvgm", "mutool"] as const;
export type TeXExecutableName = (typeof NAMES)[number];

export async function probeExecutable(name: string, configuredPath: string): Promise<ExecutableProbe> {
  const candidate = configuredPath.trim() || name;
  try {
    const result = await execFileAsync(candidate, ["--version"], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const firstLine = String(result.stdout || result.stderr).split(/\r?\n/u).find((line) => line.trim())?.trim();
    return { name, configuredPath: candidate, resolvedPath: path.isAbsolute(candidate) ? candidate : undefined, version: firstLine, ok: true };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    return { name, configuredPath: candidate, resolvedPath: path.isAbsolute(candidate) ? candidate : undefined, ok: false, error: e.code === "ENOENT" ? "Executable not found" : e.message };
  }
}

export async function probeAllExecutables(paths: Partial<Record<TeXExecutableName, string>>): Promise<ExecutableProbe[]> {
  return Promise.all(NAMES.map((name) => probeExecutable(name, paths[name] ?? name)));
}

/** Find TeX Live without assuming the user's drive letter or release year. */
export async function discoverTeXLiveRoot(): Promise<string | undefined> {
  const pathRoot = await findTeXExecutableOnPath("xelatex");
  if (pathRoot) return pathRoot;

  if (process.platform === "win32") {
    for (const drive of ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"]) {
      for (let year = 2030; year >= 2015; year--) {
        const root = `${drive}:\\texlive\\${year}`;
        if (await fileExists(path.join(root, "bin", "windows", "xelatex.exe"))) return root;
      }
    }
  }
  return undefined;
}

async function findTeXExecutableOnPath(name: string): Promise<string | undefined> {
  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const result = await execFileAsync(command, [process.platform === "win32" ? `${name}.exe` : name], { timeout: 3000, windowsHide: true, maxBuffer: 128 * 1024 });
    const executable = String(result.stdout).split(/\r?\n/u).map((x) => x.trim()).find(Boolean);
    if (!executable) return undefined;
    const normalized = path.normalize(executable);
    const bin = path.dirname(normalized);
    const marker = path.join("bin", process.platform === "win32" ? "windows" : process.platform === "darwin" ? "universal-darwin" : "x86_64-linux");
    return bin.toLowerCase().endsWith(marker.toLowerCase()) ? path.dirname(path.dirname(bin)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accept either the TeX Live installation root (D:\\texlive\\2025) or its
 * Windows binary directory (D:\\texlive\\2025\\bin\\windows).
 */
export function texLiveExecutableCandidates(root: string): Partial<Record<TeXExecutableName, string>> {
  const clean = path.normalize(root.trim().replace(/[\\/]+$/u, ""));
  if (!clean) return {};

  const normalizedLower = clean.toLowerCase();
  const binSuffix = path.join("bin", process.platform === "win32" ? "windows" : process.platform === "darwin" ? "universal-darwin" : "x86_64-linux").toLowerCase();
  const bin = normalizedLower.endsWith(binSuffix)
    ? clean
    : path.join(clean, "bin", process.platform === "win32" ? "windows" : process.platform === "darwin" ? "universal-darwin" : "x86_64-linux");

  const suffix = process.platform === "win32" ? ".exe" : "";
  return Object.fromEntries(NAMES.map((name) => [name, path.join(bin, `${name}${suffix}`)])) as Partial<Record<TeXExecutableName, string>>;
}

export async function validateExecutablePaths(paths: Partial<Record<TeXExecutableName, string>>): Promise<Partial<Record<TeXExecutableName, string>>> {
  const valid: Partial<Record<TeXExecutableName, string>> = {};
  for (const name of NAMES) {
    const value = paths[name];
    if (value && await fs.stat(value).then((s) => s.isFile()).catch(() => false)) valid[name] = value;
  }
  return valid;
}

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then((s) => s.isFile()).catch(() => false);
}
