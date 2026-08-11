const PACKAGE_BY_PATTERN: Array<[RegExp, string]> = [
  [/\\begin\{(?:align|align\*|gather|gather\*|multline|multline\*)\}/u, "amsmath"],
  [/\\(?:dfrac|tfrac|binom|text|operatorname\*?)\b/u, "amsmath"],
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
  [/\\setlist\b|\\begin\{description\}/u, "enumitem"],
  [/\\begin\{tikzcd\}/u, "tikz-cd"],
  [/\\smartdiagram\b/u, "smartdiagram"],
  [/\\pie\b|\\wheel\b/u, "pgf-pie"],
  [/\\gantt(?:bar|group|newline|link)\b/u, "pgfgantt"],
];

const LIBRARY_BY_PATTERN: Array<[RegExp, string]> = [
  [/\b(?:Stealth|Latex|Triangle|Computer Modern Rightarrow)\b/u, "arrows.meta"],
  [/\b(?:automata|state|accepting|initial by arrow)\b/u, "automata"],
  [/\b(?:backgrounds|on background layer)\b/u, "backgrounds"],
  [/\b(?:chainin|start chain|continue chain|join chain)\b/u, "chains"],
  [/\b(?:circuitikz|to\[.*?(?:R|C|L|D|op amp))\b/isu, "circuits"],
  [/\b(?:decorate|decoration=|snake|zigzag|brace)\b/u, "decorations"],
  [/\b(?:markings|mark=at position)\b/u, "decorations.markings"],
  [/\b(?:snake|coil|bent|random steps)\b/u, "decorations.pathmorphing"],
  [/\b(?:replace|show path construction steps)\b/u, "decorations.pathreplacing"],
  [/\b(?:ellipse connection|crossing over|er)\b/u, "er"],
  [/\b(?:fadings|fade=|path fading)\b/u, "fadings"],
  [/\b(?:fit=|fit\s*=)\b/u, "fit"],
  [/\b(?:graph\s+\{|graph\[|\bgraphs\b)/u, "graphs"],
  [/\b(?:name intersections|of=|by=)\b/u, "intersections"],
  [/\b(?:matrix of|matrix\s+of|matrix\[)/u, "matrix"],
  [/\b(?:mindmap|concept color|concept connection)\b/u, "mindmap"],
  [/\b(?:pattern=|pattern color|patterns)\b/u, "patterns"],
  [/\b(?:above=of|below=of|left=of|right=of|above left=of|below right=of)\b/u, "positioning"],
  [/\b(?:quotes|pic\s+\{|\"[^\"]+\"\s+edge)\b/u, "quotes"],
  [/\b(?:scope\s*\[.*?on background layer|local bounding box)\b/isu, "scopes"],
  [/\b(?:diamond|trapezium|regular polygon|ellipse)\b/u, "shapes.geometric"],
  [/\b(?:single arrow|double arrow|triangle 90|signal)\b/u, "shapes.arrows"],
  [/\b(?:callout|cloud callout|ellipse callout)\b/u, "shapes.callouts"],
  [/\b(?:rounded rectangle|rectangle split|trapezium split)\b/u, "shapes.multipart"],
  [/\b(?:drop shadow|copy shadow|preaction=\{draw=none,shadow)\b/u, "shadows"],
  [/\b(?:spy using outlines|spy on node)\b/u, "spy"],
  [/\b(?:through=|circle through|ellipse through)\b/u, "through"],
  [/\b(?:\bchild\b.*\bchild\b|grow(?:'|=| right| left| up| down))\b/isu, "trees"],
  [/\b(?:pic\s+\{|angle|angle radius|angle eccentricity)\b/u, "angles"],
  [/\b(?:axis cs:|rel axis cs:|canvas cs:|xyz cylindrical cs:)\b/u, "3d"],
  [/\b(?:babel|\bcsname\b)/u, "babel"],
];

const ALWAYS_LIBRARIES = [
  "arrows.meta", "calc", "positioning", "shapes.geometric",
];

export function augmentPreamble(preamble: string, source: string): string {
  const combined = `${preamble}\n${source}`;
  const packages = new Set<string>();
  const libraries = new Set<string>();

  for (const [pattern, packageName] of PACKAGE_BY_PATTERN) {
    if (pattern.test(source) && !hasUsepackage(preamble, packageName)) packages.add(packageName);
  }

  for (const library of ALWAYS_LIBRARIES) {
    if (!hasTikzLibrary(preamble, library)) libraries.add(library);
  }
  for (const [pattern, library] of LIBRARY_BY_PATTERN) {
    if (pattern.test(source) && !hasTikzLibrary(preamble, library)) libraries.add(library);
  }

  if (packages.size === 0 && libraries.size === 0) return preamble;
  const packageBlock = [...packages].map((name) => `\\usepackage{${name}}`).join("\n");
  const libraryBlock = libraries.size > 0 ? `\\usetikzlibrary{${[...libraries].join(",")}}` : "";
  return [preamble.trimEnd(), packageBlock, libraryBlock].filter(Boolean).join("\n") + "\n";
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
