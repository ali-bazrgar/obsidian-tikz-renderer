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
for (const item of codeMirrorImports) {
  if (!item.external) throw new Error(`CodeMirror import is not externalized: ${item.path}`);
}

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const packages = lock.packages ?? {};
for (const packageName of ["@codemirror/state", "@codemirror/view"]) {
  const prefix = `node_modules/${packageName}`;
  const instances = Object.entries(packages).filter(([key]) => key === prefix || key.endsWith(`/node_modules/${packageName}`));
  const versions = [...new Set(instances.map(([, value]) => value?.version).filter(Boolean))];
  if (versions.length > 1) throw new Error(`Multiple installed ${packageName} versions detected: ${versions.join(", ")}`);
  if (instances.length === 0) throw new Error(`Locked dependency missing: ${packageName}`);
}

console.log("Build artifacts verified.");
console.log(`esbuild bundled inputs: ${Object.keys(meta.inputs ?? {}).length}`);
console.log("CodeMirror state/view are external runtime modules and have a single locked version each.");
