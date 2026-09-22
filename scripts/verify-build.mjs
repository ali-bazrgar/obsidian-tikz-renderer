import { readFile, stat } from "node:fs/promises";

const required = ["main.js", "manifest.json", "styles.css", "meta.json", "package-lock.json"];
for (const file of required) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error("Missing or empty build artifact: " + file);
}

const meta = JSON.parse(await readFile("meta.json", "utf8"));
if (!meta.outputs?.["main.js"]) throw new Error("esbuild metafile does not contain main.js output metadata.");

const main = await readFile("main.js", "utf8");
if (main.includes("@codemirror/state") || main.includes("@codemirror/view")) {
  throw new Error("CodeMirror runtime references were found in main.js.");
}

const renderer = await readFile("src/ui/renderer-view.ts", "utf8");
const rendererChecks = [
  ['parseFromString(this.result.svg, "image/svg+xml")', "inline SVG rendering"],
  ['win?.addEventListener("wheel", wheel, { passive: false, capture: true })', "capture-phase wheel handling"],
  ['this.result.assetPath = await this.exportService.saveSvg', "SVG asset persistence"],
  ['svg.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); })', "non-clickable inline SVG"],
  ['const isReadingMode = (): boolean => !!shell.closest(".markdown-preview-view")', "Reading mode detection"],
  ['shell.dataset.mode = nextReadingMode ? "reading" : "writing"', "Reading/Writing mode state"],
  ['this.service.render(this.source, this.kind, this.sourcePath)', "source-path-aware re-render"],
];
for (const [needle, label] of rendererChecks) {
  if (!renderer.includes(needle)) throw new Error("Missing renderer invariant: " + label);
}
if (renderer.includes("svgDataUri")) throw new Error("Renderer must not use SVG data URIs.");

const processor = await readFile("src/markdown/code-block.ts", "utf8");
if (!processor.includes("service.render(source, kind, ctx.sourcePath)")) throw new Error("Markdown renderer must pass the note path into RenderService.");
if (!processor.includes("if (result.warning) new Notice(result.warning")) throw new Error("Best-effort render warnings must be surfaced.");

const render = await readFile("src/core/render-service.ts", "utf8");
const renderChecks = [
  ["new TeXDependencyResolver(", "integrated dependency resolver"],
  ["rewriteExternalReferences(", "vault dependency rewriting"],
  ["--no-fonts", "font outlines as paths"],
  ["--exact-bbox", "exact character bounding boxes"],
  ["--embed-bitmaps", "embedded bitmap assets"],
  ["bestEffortOutput", "best-effort setting"],
  ["shellEscape", "shell escape setting"],
  ["buildFullDocument(", "full-document dependency injection"],
  ['kind === "tex" || kind === "latex"', "general LaTeX wrapper handling"],
  ["sourcePath?: string", "source-file context"],
  ["augmentPreamble(extractDocumentPreamble(source), source)", "full-document source package detection"],
  ["normalizeLatexSource(", "LaTeX display-math normalization"],
  ["dvilualatex is not a compatible SVG backend", "LuaTeX DVI guard"],
];
for (const [needle, label] of renderChecks) {
  if (!render.includes(needle)) throw new Error("Missing render invariant: " + label);
}

const settings = await readFile("src/settings/settings.ts", "utf8");
if (!settings.includes("bestEffortOutput: boolean")) throw new Error("Best-effort setting is missing.");
if (!settings.includes('shellEscape: "disabled" | "restricted" | "enabled"')) throw new Error("Shell-escape setting is missing.");
if (!settings.includes("bestEffortOutput: true")) throw new Error("Best-effort default is missing.");
if (!settings.includes('shellEscape: "disabled"')) throw new Error("Safe shell-escape default is missing.");
if (!settings.includes("persianFontPath: string")) throw new Error("Persian font file path setting is missing.");

const types = await readFile("src/core/types.ts", "utf8");
if (!types.includes("warning?: string")) throw new Error("RenderResult warning field is missing.");

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== pkg.version || pkg.version !== "0.1.6") throw new Error("Plugin versions are not synchronized at 0.1.6.");
if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) throw new Error("package-lock.json version is out of sync.");

const css = await readFile("styles.css", "utf8");
const compactCss = css.replace(/\s+/g, "");
if (!compactCss.includes('.tikz-renderer-panel[hidden]{display:none!important}')) throw new Error("Popup hidden-state CSS is missing.");
if (!compactCss.includes("opacity:1!important")) throw new Error("TikZ figure opacity guard is missing.");
if (!css.includes('.markdown-preview-view a.tikz-generated-asset-link') || !css.includes('display:none!important')) throw new Error("Reading-view generated SVG link hiding is missing.");

const detector = await readFile("src/core/tex-package-detector.ts", "utf8");
if (!detector.includes('"amsthm"') || !detector.includes('"hyperref"') || !detector.includes('"mhchem"') || !detector.includes('"unicode-math"') || !detector.includes("insertBeforeFirstMathCommand")) throw new Error("Expanded LaTeX package detection is missing.");
if (!detector.includes("insertPackagesBeforeXePersian")) throw new Error("XePersian package-ordering protection is missing.");

const resolver = await readFile("src/core/tex-dependency-resolver.ts", "utf8");
if (!resolver.includes("Undefined\\s+control\\s+sequence")) throw new Error("Undefined-control-sequence dependency resolution is missing.");
if (!resolver.includes("tikzlibrary") || !resolver.includes("not\\s+found")) throw new Error("TikZ library missing-file parsing is missing.");

console.log("Build artifacts and rendering-pipeline invariants verified.");
