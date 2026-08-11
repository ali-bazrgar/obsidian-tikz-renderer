export type Engine = "auto" | "latex" | "pdflatex" | "xelatex" | "lualatex" | "dvilualatex";
export type DisplayTheme = "auto" | "obsidian" | "light" | "paper" | "dark" | "contrast" | "bw" | "custom";

export interface TikzSettings {
  engine: Engine;
  latexPath: string;
  pdflatexPath: string;
  xelatexPath: string;
  lualatexPath: string;
  dvilualatexPath: string;
  dvisvgmPath: string;
  mutoolPath: string;
  texLiveRoot: string;
  assetFolder: string;
  cacheFolder: string;
  displayTheme: DisplayTheme;
  customBackgroundColor: string;
  customBackgroundOpacity: number;
  defaultZoom: number;
  keepTexSource: boolean;
  compileTimeout: number;
  persianFont: string;
  preamble: string;
  historyLimit: number;
}

// Keep the default preamble deliberately small. Optional packages and TikZ
// libraries are added by augmentPreamble() when the source actually needs them.
// This avoids making every tiny TikZ block load pgfplots, circuitikz, forest,
// smartdiagram, pgfgantt, and dozens of libraries before compilation starts.
export const DEFAULT_PREAMBLE = String.raw`\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{amsfonts}
\usepackage{mathtools}
\usepackage{bm}
\usepackage{xcolor}
\usepackage{graphicx}
\usepackage{tikz}`;

export const DEFAULT_SETTINGS: TikzSettings = {
  engine: "auto",
  latexPath: "latex",
  pdflatexPath: "pdflatex",
  xelatexPath: "xelatex",
  lualatexPath: "lualatex",
  dvilualatexPath: "dvilualatex",
  dvisvgmPath: "dvisvgm",
  mutoolPath: "mutool",
  texLiveRoot: "",
  assetFolder: "TikZ Assets",
  cacheFolder: ".tikz-cache",
  displayTheme: "auto",
  customBackgroundColor: "#ffffff",
  customBackgroundOpacity: 100,
  defaultZoom: 100,
  keepTexSource: false,
  compileTimeout: 30000,
  persianFont: "Vazirmatn",
  preamble: DEFAULT_PREAMBLE,
  historyLimit: 20,
};
