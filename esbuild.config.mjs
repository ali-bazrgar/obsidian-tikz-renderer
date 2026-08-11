import esbuild from "esbuild";

const production = process.argv[2] === "production";

await esbuild.build({
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
  metafile: production ? "meta.json" : undefined,
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  treeShaking: true,
});

console.log(production ? "Production build complete." : "Development build complete.");
