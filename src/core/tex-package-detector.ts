const PACKAGE_BY_PATTERN: Array<[RegExp, string]> = [
  [/\\begin\{(?:align|align\*|alignat|alignat\*|gather|gather\*|multline|multline\*|flalign|flalign\*)\}/u, "amsmath"],
  [/\\(?:dfrac|tfrac|binom|dbinom|tbinom|text|operatorname\*?|overset|underset|DeclareMathOperator)\b/u, "amsmath"],
  [/\\mathbb\b/u, "amssymb"],
  [/\\mathfrak\b|\\mathcal\b/u, "amsfonts"],
  [/\\bm\b/u, "bm"],
  [/\\qty\b|\\DeclarePairedDelimiter|\\coloneqq\b/u, "mathtools"],
  [/\\SI\b|\\num\b|\\ang\b|\\qtyrange\b/u, "siunitx"],
  [/\\cancel\b|\\bcancel\b|\\xcancel\b/u, "cancel"],
  [/\\ce\{|\\pu\{/u, "chemformula"],
  [/\\chemfig\b|\\setchemfig\b/u, "chemfig"],
  [/\\includegraphics\b/u, "graphicx"],
  [/\\toprule\b|\\midrule\b|\\bottomrule\b|\\cmidrule\b/u, "booktabs"],
  [/\\multirow\b/u, "multirow"],
  [/\\tabularx\b/u, "tabularx"],
  [/\\begin\{longtable\}/u, "longtable"],
  [/\\setlist\b/u, "enumitem"],
  [/\\url\b|\\href\b/u, "hyperref"],
  [/\\lstinline\b|\\begin\{lstlisting\}/u, "listings"],
  [/\\begin\{minted\}/u, "minted"],
  [/\\rowcolor\b|\\cellcolor\b|\\definecolor\b/u, "xcolor"],
  [/\\begin\{tikzcd\}/u, "tikz-cd"],
  [/\\smartdiagram\b/u, "smartdiagram"],
  [/\\pie\b|\\wheel\b/u, "pgf-pie"],
  [/\\gantt(?:bar|group|newline|link)\b/u, "pgfgantt"],
  [/\\begin\{circuitikz\}/u, "circuitikz"],
  [/\\begin\{forest\}|\\forestset\b/u, "forest"],
  [/\\begin\{venndiagram\}|\\begin\{Venn\}/u, "venndiagram"],
  [/\\begin\{neuralnetwork\}|\\nodeconn\b|\\linklayers\b/u, "neuralnetwork"],
  [/\\begin\{(?:axis|semilogxaxis|semilogyaxis|loglogaxis|polaraxis|smithchart)\}/u, "pgfplots"],
  [/\\addplot3?\b|\\addlegendentry\b|\\pgfplotsinvokeforeach\b/u, "pgfplots"],
];

const LIBRARY_BY_PATTERN: Array<[RegExp, string]> = [
  [/\$\([^\n]*\)(?:\s*!\s*[^!]+!|\s*[+\-*/]\s*)/u, "calc"],
  [/\b(?:Stealth|Latex|Triangle|Computer Modern Rightarrow|To)\b/u, "arrows.meta"],
  [/\b(?:automata|state|accepting|initial by arrow)\b/u, "automata"],
  [/\b(?:on background layer|backgrounds)\b/u, "backgrounds"],
  [/\b(?:start chain|continue chain|join chain)\b/u, "chains"],
  [/\b(?:decorate|decoration=|snake|zigzag|brace)\b/u, "decorations"],
  [/\b(?:markings|mark=at position)\b/u, "decorations.markings"],
  [/\b(?:coil|random steps|pathmorphing)\b/u, "decorations.pathmorphing"],
  [/\b(?:pathreplacing|replace path|show path construction steps)\b/u, "decorations.pathreplacing"],
  [/\b(?:ellipse connection|crossing over|entity relationship)\b/u, "er"],
  [/\b(?:fade=|path fading|fadings)\b/u, "fadings"],
  [/\bfit\s*=\s*\([^)]*\)/u, "fit"],
  [/\\graph\b|\bgraph\s*\[/u, "graphs"],
  [/\b(?:name intersections|of=|by=)\b/u, "intersections"],
  [/\bmatrix\s+of\b|\bmatrix\s*\[/u, "matrix"],
  [/\b(?:mindmap|concept color|concept connection)\b/u, "mindmap"],
  [/\bpattern\s*=|\bpattern color\b/u, "patterns"],
  [/\b(?:above|below|left|right|above left|below right|above right|below left)\s*=\s*(?:[^,\]\n]*?\s+)?of\s+/u, "positioning"],
  [/\bpic\s*\[[^\]]*["']|\bpic\s*\[[^\]]*\bpic text\s*=/u, "quotes"],
  [/\b(?:scope\s*\[|local bounding box)\b/u, "scopes"],
  [/\b(?:diamond|trapezium|regular polygon|ellipse|kite|starburst)\b/u, "shapes.geometric"],
  [/\b(?:single arrow|double arrow|triangle 90|signal)\b/u, "shapes.arrows"],
  [/\b(?:callout|cloud callout|ellipse callout)\b/u, "shapes.callouts"],
  [/\b(?:rectangle split|trapezium split|circle split)\b/u, "shapes.multipart"],
  [/\b(?:drop shadow|copy shadow|shadowed)\b/u, "shadows"],
  [/\b(?:spy using outlines|spy on node)\b/u, "spy"],
  [/\b(?:through=|circle through|ellipse through)\b/u, "through"],
  [/\b(?:child\s*\{|grow(?:'|=|\s+(?:right|left|up|down)))\b/isu, "trees"],
  [/\b(?:angle\s*=|angle radius|angle eccentricity|right angle)\b/u, "angles"],
  [/\b(?:xyz cylindrical cs:|canvas is xy plane at z|canvas cs:|xyz spherical cs:)\b/u, "3d"],
  [/\b(?:name path|name path global)\b/u, "intersections"],
  [/\b(?:external|external path|graph drawing|graphdrawing)\b/iu, "graphdrawing"],
];

export function augmentPreamble(preamble: string, source: string): string {
  const combined = `${preamble}\n${source}`;
  const packages = new Set<string>();
  const libraries = new Set<string>();

  for (const [pattern, packageName] of PACKAGE_BY_PATTERN) {
    if (pattern.test(source) && !hasUsepackage(combined, packageName)) packages.add(packageName);
  }

  for (const [pattern, library] of LIBRARY_BY_PATTERN) {
    if (pattern.test(source) && !hasTikzLibrary(combined, library)) libraries.add(library);
  }

  if (packages.has("pgfplots") || hasUsepackage(combined, "pgfplots")) {
    if (!/\\pgfplotsset\s*\{[^}]*\bcompat\s*=\s*1\.18\b[^}]*\}/u.test(combined)) {
      packages.add("pgfplots");
      return appendPgfplotsCompat(appendDependencies(preamble, packages, libraries));
    }
  }

  return appendDependencies(preamble, packages, libraries);
}

function appendDependencies(preamble: string, packages: Set<string>, libraries: Set<string>): string {
  if (packages.size === 0 && libraries.size === 0) return preamble;
  const packageBlock = [...packages].map((name) => `\\usepackage{${name}}`).join("\n");
  const libraryBlock = libraries.size > 0 ? `\\usetikzlibrary{${[...libraries].join(",")}}` : "";
  return [preamble.trimEnd(), packageBlock, libraryBlock].filter(Boolean).join("\n") + "\n";
}

function appendPgfplotsCompat(preamble: string): string {
  return `${preamble.trimEnd()}\n\\pgfplotsset{compat=1.18}\n`;
}

function hasUsepackage(text: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  return new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "u").test(text);
}

function hasTikzLibrary(text: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  return new RegExp(`\\\\usetikzlibrary\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "u").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
