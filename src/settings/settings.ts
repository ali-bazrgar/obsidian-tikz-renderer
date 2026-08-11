export type Engine = "auto" | "latex" | "pdflatex" | "xelatex" | "lualatex" | "dvilualatex";
export type DisplayTheme = "auto" | "obsidian" | "light" | "paper" | "dark" | "contrast" | "bw";
export interface TikzSettings { engine: Engine; latexPath: string; pdflatexPath: string; xelatexPath: string; lualatexPath: string; dvilualatexPath: string; dvisvgmPath: string; mutoolPath: string; assetFolder: string; cacheFolder: string; displayTheme: DisplayTheme; defaultZoom: number; keepTexSource: boolean; compileTimeout: number; persianFont: string; preamble: string; historyLimit: number; }
export const DEFAULT_PREAMBLE = String.raw`\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{amsfonts}
\usepackage{mathtools}
\usepackage{bm}
\usepackage{xcolor}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{array}
\usepackage{multirow}
\usepackage{tabularx}
\usepackage{longtable}
\usepackage{siunitx}
\usepackage{enumitem}
\usepackage{tikz}
\usepackage{pgfplots}
\usepackage{circuitikz}
\usepackage{tikz-cd}
\usepackage{forest}
\usepackage{smartdiagram}
\usepackage{pgf-pie}
\usepackage{pgfgantt}
\pgfplotsset{compat=1.18}
\usetikzlibrary{arrows,arrows.meta,automata,backgrounds,calc,chains,circuits,decorations,decorations.markings,decorations.pathmorphing,decorations.pathreplacing,er,fadings,fit,graphs,intersections,matrix,mindmap,patterns,positioning,quotes,scopes,shapes,shapes.arrows,shapes.callouts,shapes.geometric,shapes.misc,shapes.multipart,shadows,spy,through,trees,angles,babel,3d}`;
