import { readFile, stat } from "node:fs/promises";

const required = ["main.js", "manifest.json", "styles.css"];
for (const file of required) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`Missing or empty build artifact: ${file}`);
}

const meta = JSON.parse(await readFile("meta.json", "utf8"));
const inputs = Object.keys(meta.inputs ?? {});

// CodeMirror is intentionally externalized. Therefore its source must not be
// present in the plugin bundle at all. This prevents a second runtime instance
// from being shipped by the plugin.
for (const packageName of ["@codemirror/state", "@codemirror/view"]) {
  const matches = inputs.filter((input) => input.includes(`node_modules/${packageName}/`));
  if (matches.length > 0) {
    throw new Error(`External CodeMirror package was bundled: ${packageName}\n${matches.join("\n")}`);
  }
}

console.log("Build artifacts verified.");
console.log(`esbuild inputs: ${inputs.length}`);
console.log("CodeMirror state/view are external runtime modules; no bundled copies detected.");
