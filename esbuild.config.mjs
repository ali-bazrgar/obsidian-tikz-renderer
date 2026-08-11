import esbuild from "esbuild";
import { writeFile } from "node:fs/promises";

const production = process.argv[2] === "production";

const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian supplies these modules at runtime. Keeping CodeMirror external
  // is intentional: embedding a second @codemirror/state or @codemirror/view
  // instance can make instanceof-based extension checks fail.
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
  ],
  format: "cjs",
  platform: "node",
  target: "es2018",
  outfile: "main.js",
  metafile: production,
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  treeShaking: true,
});

if (production && result.metafile) {
  await writeFile("meta.json", result.metafile, "utf8");
}

console.log(production ? "Production build complete." : "Development build complete.");
