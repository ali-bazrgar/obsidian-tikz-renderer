export type Engine = "auto" | "latex" | "pdflatex" | "xelatex" | "lualatex" | "dvilualatex";

export type BlockKind = "tikz" | "pgfplots" | "circuitikz" | "tex" | "latex";

export interface EnginePlan {
  engine: Exclude<Engine, "auto">;
  executable: string;
  outputType: "pdf" | "dvi";
}

export interface RenderResult {
  svg: string;
  hash: string;
  engine: Exclude<Engine, "auto">;
  fromCache: boolean;
  source: string;
  kind: BlockKind;
}

export interface InstallationResult {
  results: Record<string, boolean>;
  summary: string;
}

export interface CommandFailure {
  executable: string;
  args: string[];
  code?: string | number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}
