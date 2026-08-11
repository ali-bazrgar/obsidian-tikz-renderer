import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface ExecutableProbe {
  name: string;
  configuredPath: string;
  resolvedPath?: string;
  version?: string;
  ok: boolean;
  error?: string;
}

const DEFAULT_NAMES = ["latex", "pdflatex", "xelatex", "lualatex", "dvilualatex", "dvisvgm", "mutool"] as const;

export async function probeExecutable(name: string, configuredPath: string): Promise<ExecutableProbe> {
  const candidate = configuredPath.trim() || name;
  try {
    const result = await execFileAsync(candidate, ["--version"], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const version = String(result.stdout || result.stderr).split(/\r?\n/u)[0]?.trim();
    return { name, configuredPath: candidate, resolvedPath: resolveDisplayPath(candidate), version, ok: true };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    return {
      name,
      configuredPath: candidate,
      resolvedPath: resolveDisplayPath(candidate),
      ok: false,
      error: e.code === "ENOENT" ? "Executable not found" : e.message,
    };
  }
}

export async function probeAllExecutables(paths: Partial<Record<(typeof DEFAULT_NAMES)[number], string>>): Promise<ExecutableProbe[]> {
  return Promise.all(DEFAULT_NAMES.map((name) => probeExecutable(name, paths[name] ?? name)));
}

function resolveDisplayPath(value: string): string | undefined {
  if (path.isAbsolute(value)) return value;
  return undefined;
}
