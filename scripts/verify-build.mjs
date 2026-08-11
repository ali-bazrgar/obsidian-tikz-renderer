import { readFile, stat } from "node:fs/promises";

const required = ["main.js", "manifest.json", "styles.css"];
for (const file of required) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`Missing or empty build artifact: ${file}`);
}

const meta = JSON.parse(await readFile("meta.json", "utf8"));
const inputs = Object.keys(meta.inputs ?? {});

for (const packageName of ["@codemirror/state", "@codemirror/view"]) {
  const matches = inputs.filter((input) => input.includes(`node_modules/${packageName}/`));
  const packageVersions = new Set(matches.map((input) => input.split(`node_modules/${packageName}/`)[0]));
  if (packageVersions.size > 1) {
    throw new Error(`Duplicate ${packageName} dependency roots detected in esbuild graph:\n${matches.join("\n")}`);
  }
}

console.log("Build artifacts verified.");
console.log(`esbuild inputs: ${inputs.length}`);
console.log("CodeMirror dependency roots: single-instance within the plugin bundle.");
