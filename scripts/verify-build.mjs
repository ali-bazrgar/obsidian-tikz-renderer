import { readFile, stat } from "node:fs/promises";

const required = ["main.js", "manifest.json", "styles.css", "meta.json", "package-lock.json"];
for (const file of required) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`Missing or empty build artifact: ${file}`);
}

const meta = JSON.parse(await readFile("meta.json", "utf8"));
const output = meta.outputs?.["main.js"];
if (!output) throw new Error("esbuild metafile does not contain main.js output metadata.");

const codeMirrorImports = (output.imports ?? []).filter((item) => item.path === "@codemirror/state" || item.path === "@codemirror/view" || item.path.startsWith("@codemirror/state/") || item.path.startsWith("@codemirror/view/"));
if (codeMirrorImports.length > 0) throw new Error(`The production plugin bundle must not load a private CodeMirror runtime: ${codeMirrorImports.map((item) => item.path).join(", ")}`);

const main = await readFile("main.js", "utf8");
if (main.includes("@codemirror/state") || main.includes("@codemirror/view")) throw new Error("CodeMirror runtime references were found in main.js.");

const renderer = await readFile("src/ui/renderer-view.ts", "utf8");
if (!renderer.includes('parseFromString(this.result.svg, "image/svg+xml")')) throw new Error("Reading-mode renderer is not using inline SVG DOM rendering.");
if (renderer.includes("svgDataUri") || renderer.includes('src: svgDataUri')) throw new Error("Reading-mode renderer must not use SVG data-URI images.");
if (!renderer.includes('panel.hidden = true')) throw new Error("TikZ settings panel is not hidden during initial render.");
if (!renderer.includes('win?.addEventListener("wheel", wheel, { passive: false, capture: true })')) throw new Error("Ctrl+wheel zoom must be registered at window capture level.");
if (!renderer.includes('this.result.assetPath = await this.exportService.saveSvg')) throw new Error("Every rendered TikZ result must persist an SVG asset in the vault.");
if (!renderer.includes('`![[${path}]]`')) throw new Error("Renderer must expose an Obsidian SVG embed link.");

const livePreview = await readFile("src/editor/live-preview.ts", "utf8");
if (livePreview.includes("svgDataUri") || livePreview.includes('createEl(\"img\"')) throw new Error("Live Preview must not rasterize TikZ SVG through an image data URI.");

const processor = await readFile("src/markdown/code-block.ts", "utf8");
if (!processor.includes("const wikilink = `[[${assetPath}]]`;")) throw new Error("TikZ processor must create a real Obsidian wikilink for the generated SVG.");
if (!processor.includes("ensureSourceAssetLink")) throw new Error("TikZ processor is missing source asset-link synchronization.");

const css = await readFile("styles.css", "utf8");
if (!css.includes('.tikz-renderer-panel[hidden]{display:none!important}')) throw new Error("CSS must force the popup to remain hidden until opened.");
if (!css.includes('.tikz-renderer-controls{position:absolute') || !css.includes('left:-28px')) throw new Error("TikZ controls must be attached outside the left edge of the figure.");
if (!css.includes('.tikz-renderer-paper{position:relative;display:contents}')) throw new Error("The old visual paper layer must not create a second figure window.");
if (!css.includes('.tikz-generated-asset-link{display:none!important}')) throw new Error("Generated SVG wikilinks must be hidden in Reading view.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== packageJson.version) throw new Error(`Version mismatch: manifest ${manifest.version}, package.json ${packageJson.version}.`);

const inputs = Object.keys(meta.inputs ?? {});
console.log("Build artifacts verified.");
console.log(`esbuild bundled inputs: ${inputs.length}`);
console.log("Verified: inline SVG, hidden popup startup, capture-phase Ctrl+wheel zoom, one visual figure layer, left-attached controls, and source-mode SVG wikilinks hidden in Reading view.");
