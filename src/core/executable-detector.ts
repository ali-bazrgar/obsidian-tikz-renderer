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

export function texLiveExecutableCandidates(root: string): Partial<Record<TeXExecutableName, string>> {
  const clean = root.trim();
  if (!clean) return {};
  const bin = path.join(clean, "bin", process.platform === "win32" ? "windows" : process.platform === "darwin" ? "universal-darwin" : "x86_64-linux");
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
