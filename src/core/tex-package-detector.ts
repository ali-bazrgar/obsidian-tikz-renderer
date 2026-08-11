const PACKAGE_BY_PATTERN: Array<[RegExp, string]> = [
  [/\\begin\{(?:align|align\*|gather|gather\*|multline|multline\*)\}/u, "amsmath"],
  [/\\(?:dfrac|tfrac|binom|text|operator\*?)\b/u, "amsmath"],
  [/\\mathbb\b/u, "amssymb"],
  [/\\mathfrak\b/u, "amsfonts"],
  [/\\bm\b/u, "bm"],
  [/\\qty\b|\\DeclarePairedDelimiter/u, "mathtools"],
  [/\\SI\b|\\num\b|\\ang\b/u, "siunitx"],
  [/\\includegraphics\b/u, "graphicx"],
  [/\\toprule\b|\\midrule\b|\\bottomrule\b/u, "booktabs"],
  [/\\multirow\b/u, "multirow"],
  [/\\tabularx\b/u, "tabularx"],
  [/\\begin\{longtable\}/u, "longtable"],
  [/\\setlist\b/u, "enumitem"],
  [/\\begin\{tikzcd\}/u, "tikz-cd"],
  [/\\smartdiagram\b/u, "smartdiagram"],
  [/\\pie\b|\\wheel\b/u, "pgf-pie"],
  [/\\gantt(?:bar|group|newline|link)\b/u, "pgfgantt"],
  [/\\begin\{circuitikz\}/u, "circuitikz"],
  [/\\begin\{forest\}|\\forestset\b/u, "forest"],
];

// Conservative, source-driven TikZ library detection. Libraries are not
// loaded globally; they are added only when the source contains syntax that
// strongly indicates that they are needed.
const LIBRARY_BY_PATTERN: Array<[RegExp, string]> = [
  // Coordinate calculations such as ($(A)!0.5!(B)$), ($(A)+(1,0)$), etc.
  [/\$\([^\n]*\)(?:\s*!\s*[^!]+!|\s*[+\-*/]\s*)/u, "calc"],
  [/\b(?:Stealth|Latex|Triangle|Computer Modern Rightarrow)\b/u, "arrows.meta"],
  [/\b(?:automata|state|accepting|initial by arrow)\b/u, "automata"],
  [/\b(?:on background layer|backgrounds)\b/u, "backgrounds"],
  [/\b(?:start chain|continue chain|join chain|join chain)\b/u, "chains"],
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
  // Handles both `right=of A` and `right=12mm of A` forms.
  [/\b(?:above|below|left|right|above left|below right|above right|below left)\s*=\s*(?:[^,\]\n]*?\s+)?of\s+/u, "positioning"],
  // Quotes are required for pic options such as pic["$\\alpha$"]{angle}.
  [/\bpic\s*\[[^\]]*["']|\bpic\s*\[[^\]]*\bpic text\s*=/u, "quotes"],
  [/\b(?:scope\s*\[|local bounding box)\b/u, "scopes"],
  [/\b(?:diamond|trapezium|regular polygon|ellipse)\b/u, "shapes.geometric"],
  [/\b(?:single arrow|double arrow|triangle 90|signal)\b/u, "shapes.arrows"],
  [/\b(?:callout|cloud callout|ellipse callout)\b/u, "shapes.callouts"],
  [/\b(?:rectangle split|trapezium split|circle split)\b/u, "shapes.multipart"],
  [/\b(?:drop shadow|copy shadow|shadowed)\b/u, "shadows"],
  [/\b(?:spy using outlines|spy on node)\b/u, "spy"],
  [/\b(?:through=|circle through|ellipse through)\b/u, "through"],
  [/\b(?:child\s*\{|grow(?:'|=|\s+(?:right|left|up|down)))\b/isu, "trees"],
  [/\b(?:angle\s*=|angle radius|angle eccentricity|right angle)\b/u, "angles"],
  [/\b(?:xyz cylindrical cs:|canvas is xy plane at z|canvas cs:)\b/u, "3d"],
  [/\b(?:babel|csname)\b/u, "babel"],
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

  if (packages.size === 0 && libraries.size === 0) return preamble;

  const packageBlock = [...packages]
    .map((name) => `\\usepackage{${name}}`)
    .join("\n");
  const libraryBlock = libraries.size > 0
    ? `\\usetikzlibrary{${[...libraries].join(",")}}`
    : "";

  return [preamble.trimEnd(), packageBlock, libraryBlock]
    .filter(Boolean)
    .join("\n") + "\n";
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
