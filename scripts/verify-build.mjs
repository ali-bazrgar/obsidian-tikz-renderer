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
if (!renderer.includes('parseFromString(this.result.svg, "image/svg+xml")')) throw new Error("Renderer is not using inline SVG DOM rendering.");
if (renderer.includes("svgDataUri") || renderer.includes("src: svgDataUri")) throw new Error("Renderer must not use SVG data-URI images.");
if (!renderer.includes("panel.hidden = true")) throw new Error("Popup is not hidden during initial render.");
if (!renderer.includes('menu.addEventListener("pointerdown", togglePanel)')) throw new Error("Popup toggle must use a reliable pointer event.");
if (!renderer.includes('menu.addEventListener("keydown"')) throw new Error("Popup toggle must remain keyboard accessible.");
if (!renderer.includes('win?.addEventListener("wheel", wheel, { passive: false, capture: true })')) throw new Error("Ctrl+wheel zoom must be registered at window capture level.");
if (!renderer.includes("this.result.assetPath = await this.exportService.saveSvg")) throw new Error("Rendered TikZ results must persist SVG assets.");
if (!/svg\.addEventListener\("click",\s*e\s*=>\s*\{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*\}\)/.test(renderer)) throw new Error("Inline SVG must not behave as the generated asset link.");
if (!renderer.includes('text: "⋯"')) throw new Error("Writing-view controls are missing.");
if (!renderer.includes('const isReadingMode = (): boolean => !!shell.closest(".markdown-preview-view")')) throw new Error("Reading-mode detection is missing.");
if (!renderer.includes('shell.dataset.mode = nextReadingMode ? "reading" : "writing"')) throw new Error("Renderer must explicitly track Reading/Writing mode.");
if (!renderer.includes('if (isReadingMode()) return;')) throw new Error("Interactive operations must be blocked in Reading mode.");
if (!renderer.includes("const canPan = (): boolean =>")) throw new Error("Viewport overflow detection is missing.");
if (!renderer.includes("const clampPan = (): void =>")) throw new Error("Viewport pan bounds are missing.");
if (!renderer.includes("renderedWidth() - viewportWidth()")) throw new Error("Horizontal overflow must be calculated from the rendered SVG and viewport.");
if (!renderer.includes("renderedHeight() - viewportHeightValue()")) throw new Error("Vertical overflow must be calculated from the rendered SVG and viewport.");
if (!renderer.includes("if (isReadingMode() || e.button !== 0 || !canPan()) return")) throw new Error("Reading mode must lock drag and writing mode must allow drag whenever content overflows.");
if (!renderer.includes("if (isReadingMode() || !shell.isConnected) return;")) throw new Error("Ctrl+wheel zoom must be disabled in Reading mode.");

const processor = await readFile("src/markdown/code-block.ts", "utf8");
if (!processor.includes("const wikilink = `[[${assetPath}]]`;")) throw new Error("TikZ processor must create a real Obsidian wikilink.");
if (!processor.includes("ensureSourceAssetLinks")) throw new Error("TikZ processor is missing source asset-link synchronization.");
if (!processor.includes("link.classList.add(GENERATED_ASSET_CLASS)")) throw new Error("Generated SVG wikilinks must be marked directly on their anchor.");
if (!processor.includes("for (let index = lines.length - 1; index >= 0; index -= 1)")) throw new Error("Generated links must be globally cleaned before reinsertion.");
if (processor.includes("wrapper.classList.add(GENERATED_ASSET_CLASS)")) throw new Error("Generated SVG wikilinks must not hide the figure wrapper.");

const mainSource = await readFile("src/main.ts", "utf8");
if (!mainSource.includes("new MutationObserver(() => this.markGeneratedLinks())")) throw new Error("Generated-link marking must observe Obsidian's delayed link rendering.");
if (!mainSource.includes("link.dataset.tikzGenerated")) throw new Error("Generated SVG links must carry an explicit TikZ marker.");

const css = await readFile("styles.css", "utf8");
const compactCss = css.replace(/\s+/g, "");
if (!compactCss.includes('.tikz-renderer-panel[hidden]{display:none!important}')) throw new Error("CSS must force the popup to remain hidden until opened.");
if (/\.tikz-renderer-panel\{[^}]*contain:/u.test(css)) throw new Error("The fixed popup must not establish a nested containing block.");
if (compactCss.includes("tikz-renderer-paper")) throw new Error("The obsolete visual paper layer must be completely removed.");
if (!compactCss.includes('.tikz-renderer-controls{position:absolute') || !compactCss.includes('left:5px')) throw new Error("TikZ controls must remain attached to the renderer shell.");
if (!compactCss.includes('.tikz-renderer-shell{') || !compactCss.includes('background:transparent')) throw new Error("The shell must be visually transparent so it cannot form a second figure.");
if (!compactCss.includes('.tikz-renderer-viewport{') || !compactCss.includes('background:var(--tikz-figure-bg)')) throw new Error("Theme background must belong to the single visual viewport.");
if (!/\.tikz-renderer-shell\[data-mode="reading"\] \.tikz-renderer-viewport\{[^}]*pointer-events:none!important[^}]*touch-action:auto!important/u.test(css)) throw new Error("Reading mode must lock the figure against pointer interaction and restore normal touch behavior.");
if (!css.includes('.tikz-renderer-shell:not([data-theme="custom"]) .tikz-renderer-svg')) throw new Error("Custom theme must preserve the SVG's original black colors.");
if (!css.includes('.markdown-preview-view a.tikz-generated-asset-link') || !css.includes('display:none!important')) throw new Error("Generated SVG wikilinks must be hidden only in Reading view.");
if (!css.includes('.markdown-preview-view a.tikz-generated-edit-link') || !css.includes('display:none!important')) throw new Error("Generated Edit links must be hidden only in Reading view.");
if (!css.includes('.markdown-source-view .tikz-renderer-controls:not([hidden]){display:flex!important')) throw new Error("Writing-view TikZ controls must remain visible without overriding hidden state.");
if (!css.includes('.markdown-source-view .tikz-renderer-panel:not([hidden]){display:grid}')) throw new Error("Writing-view panel must only become visible when explicitly opened.");
if (!compactCss.includes("opacity:1!important")) throw new Error("TikZ figure must not be visually faded by plugin CSS.");
if (!compactCss.includes("overscroll-behavior:contain")) throw new Error("Viewport scrolling must not leak into the surrounding note while dragging.");
if (compactCss.includes("contain:paint")) throw new Error("Viewport must not use paint containment because it can clip transformed SVG content.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== packageJson.version) throw new Error(`Version mismatch: manifest ${manifest.version}, package.json ${packageJson.version}.`);

const inputs = Object.keys(meta.inputs ?? {});
console.log("Build artifacts verified.");
console.log(`esbuild bundled inputs: ${inputs.length}`);
console.log("Verified: inline SVG, explicit Reading/Writing mode, Reading-mode interaction lock, hidden popup startup, reliable popup toggle, capture-phase Ctrl+wheel zoom, overflow-aware panning, bounded pan coordinates, viewport resize handling, one visual figure layer, custom-theme SVG preservation, idempotent generated links, delayed DOM marking, and Reading-view-only generated-link hiding.");
