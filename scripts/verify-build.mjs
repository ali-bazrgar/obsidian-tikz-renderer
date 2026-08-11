import { readFile, stat } from "node:fs/promises";

const required = ["main.js", "manifest.json", "styles.css", "meta.json", "package-lock.json"];
for (const file of required) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`Missing or empty build artifact: ${file}`);
}

const meta = JSON.parse(await readFile("meta.json", "utf8"));
const output = meta.outputs?.["main.js"];
if (!output) throw new Error("esbuild metafile does not contain main.js output metadata.");

const codeMirrorImports = (output.imports ?? []).filter((item) =>
  item.path === "@codemirror/state" || item.path === "@codemirror/view" ||
  item.path.startsWith("@codemirror/state/") || item.path.startsWith("@codemirror/view/"),
);
if (codeMirrorImports.length > 0) {
  throw new Error(`The production plugin bundle must not load a private CodeMirror runtime: ${codeMirrorImports.map((item) => item.path).join(", ")}`);
}

const main = await readFile("main.js", "utf8");
if (main.includes("@codemirror/state") || main.includes("@codemirror/view")) {
  throw new Error("CodeMirror runtime references were found in main.js.");
}

const renderer = await readFile("src/ui/renderer-view.ts", "utf8");
if (!renderer.includes('parseFromString(this.result.svg, "image/svg+xml")')) {
  throw new Error("Reading-mode renderer is not using inline SVG DOM rendering.");
}
if (renderer.includes("svgDataUri") || renderer.includes('src: svgDataUri')) {
  throw new Error("Reading-mode renderer must not use SVG data-URI images.");
}

const livePreview = await readFile("src/editor/live-preview.ts", "utf8");
if (livePreview.includes("svgDataUri") || livePreview.includes('createEl(\"img\"')) {
  throw new Error("Live Preview must not rasterize TikZ SVG through an image data URI.");
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== packageJson.version) {
  throw new Error(`Version mismatch: manifest ${manifest.version}, package.json ${packageJson.version}.`);
}

const inputs = Object.keys(meta.inputs ?? {});
console.log("Build artifacts verified.");
console.log(`esbuild bundled inputs: ${inputs.length}`);
console.log("Production bundle contains no private CodeMirror runtime and renderer uses inline SVG.");
