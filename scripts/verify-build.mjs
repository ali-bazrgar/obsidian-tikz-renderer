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
if (renderer.includes("svgDataUri") || renderer.includes("src: svgDataUri")) throw new Error("Reading-mode renderer must not use SVG data-URI images.");
if (!renderer.includes("panel.hidden = true")) throw new Error("TikZ settings panel is not hidden during initial render.");
if (!renderer.includes('menu.addEventListener("pointerdown", togglePanel)')) throw new Error("TikZ popup toggle must use a reliable pointer event.");
if (!renderer.includes('menu.addEventListener("keydown"')) throw new Error("TikZ popup toggle must remain keyboard accessible.");
if (!renderer.includes('win?.addEventListener("wheel", wheel, { passive: false, capture: true })')) throw new Error("Ctrl+wheel zoom must be registered at window capture level.");
if (!renderer.includes("this.result.assetPath = await this.exportService.saveSvg")) throw new Error("Every rendered TikZ result must persist an SVG asset in the vault.");
if (!/svg\.addEventListener\("click",\s*e\s*=>\s*\{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*\}\)/.test(renderer)) throw new Error("The inline SVG must not behave as the generated asset link.");
if (!renderer.includes('text: "⋯"')) throw new Error("TikZ writing-view three-dot controls are missing.");

const processor = await readFile("src/markdown/code-block.ts", "utf8");
if (!processor.includes("const wikilink = `[[${assetPath}]]`;")) throw new Error("TikZ processor must create a real Obsidian wikilink for the generated SVG.");
if (!processor.includes("ensureSourceAssetLinks")) throw new Error("TikZ processor is missing source asset-link synchronization.");
if (!processor.includes("link.classList.add(GENERATED_ASSET_CLASS)")) throw new Error("Generated SVG wikilinks must be marked directly on their anchor.");
if (!processor.includes("for (let index = lines.length - 1; index >= 0; index -= 1)")) throw new Error("Generated links must be globally cleaned before reinsertion to prevent duplicates.");
if (processor.includes("wrapper.classList.add(GENERATED_ASSET_CLASS)")) throw new Error("Generated SVG wikilink processing must not hide the figure wrapper.");

const mainSource = await readFile("src/main.ts", "utf8");
if (!mainSource.includes("new MutationObserver(() => this.markGeneratedLinks())")) throw new Error("Generated-link marking must observe Obsidian's delayed link rendering.");
if (!mainSource.includes("link.dataset.tikzGenerated")) throw new Error("Generated SVG links must carry an explicit TikZ marker.");

const css = await readFile("styles.css", "utf8");
const compactCss = css.replace(/\s+/g, "");
if (!compactCss.includes('.tikz-renderer-panel[hidden]{display:none!important}')) throw new Error("CSS must force the popup to remain hidden until opened.");
if (css.includes(".tikz-renderer-panel{position:fixed") && css.includes("contain:layout style")) throw new Error("The fixed popup must not establish a nested containing block.");
if (!compactCss.includes('.tikz-renderer-controls{position:absolute') || !compactCss.includes('left:-28px')) throw new Error("TikZ controls must be attached outside the left edge of the figure.");
if (!compactCss.includes('.tikz-renderer-paper{position:relative;display:contents}')) throw new Error("The old visual paper layer must not create a second figure window.");
if (!css.includes('.tikz-renderer-shell{') || !css.includes('background:var(--tikz-figure-bg)')) throw new Error("Theme background must be applied to the figure shell only.");
if (!css.includes('.tikz-renderer-shell:not([data-theme="custom"]) .tikz-renderer-svg')) throw new Error("Custom theme must preserve the SVG's original black colors.");
if (!css.includes('.markdown-preview-view .tikz-generated-asset-link{display:none!important')) throw new Error("Generated SVG wikilinks must be hidden only in Reading view.");
if (!css.includes('.markdown-preview-view .tikz-generated-edit-link{display:none!important')) throw new Error("Generated Edit links must be hidden only in Reading view.");
if (!css.includes('.markdown-source-view .tikz-renderer-controls{display:flex!important')) throw new Error("Writing-view TikZ controls must remain visible.");
if (css.includes('.markdown-source-view .tikz-renderer-panel{display:grid}')) throw new Error("Writing-view panel CSS must not override the hidden attribute at startup.");
if (!css.includes('.markdown-source-view .tikz-renderer-panel:not([hidden]){display:grid}')) throw new Error("Writing-view panel must only become a grid when explicitly opened.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== packageJson.version) throw new Error(`Version mismatch: manifest ${manifest.version}, package.json ${packageJson.version}.`);

const inputs = Object.keys(meta.inputs ?? {});
console.log("Build artifacts verified.");
console.log(`esbuild bundled inputs: ${inputs.length}`);
console.log("Verified: inline SVG, hidden popup startup, reliable popup toggle, capture-phase Ctrl+wheel zoom, one visual figure layer, left-attached controls, non-clickable figure, custom-theme SVG preservation, idempotent generated links, delayed DOM marking, and Reading-view-only generated-link hiding.");
