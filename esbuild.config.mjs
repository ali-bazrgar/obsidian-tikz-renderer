import esbuild from "esbuild";
import { writeFile } from "node:fs/promises";

const production = process.argv[2] === "production";

const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // CodeMirror is imported by the editor extension and must be present in the
  // plugin bundle. Do not externalize @codemirror/*: an installed Obsidian
  // plugin does not ship its development node_modules directory, so an
  // externalized require() would fail at runtime. Duplicate-instance safety is
  // handled by exact/pinned dependency versions plus bundle verification.
  external: ["obsidian", "electron"],
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
  await writeFile("meta.json", JSON.stringify(result.metafile, null, 2), "utf8");
}

console.log(production ? "Production build complete." : "Development build complete.");
