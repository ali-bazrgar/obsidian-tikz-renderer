import esbuild from "esbuild";

const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  platform: "node",
  target: "es2018",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  treeShaking: true,
});

console.log(production ? "Production build complete." : "Development build complete.");
