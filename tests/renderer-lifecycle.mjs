import { readFile } from "node:fs/promises";

const renderer = await readFile(new URL("../src/ui/renderer-view.ts", import.meta.url), "utf8");

if (renderer.includes("previous.dispose") || renderer.includes("dispose(false)")) {
  throw new Error("Sibling renderer dispose must not exist.");
}
if (!renderer.includes('return !!el?.closest(".markdown-source-view");')) {
  throw new Error("Writable-host detection must use the source-view container.");
}
if (!renderer.includes("if (!shell.isConnected || !isWritableHost()) return;")) {
  throw new Error("openPanel must open whenever the figure is in source view.");
}
if (!renderer.includes("if (!isWritableHost() || !hostIsVisible()) return;")) {
  throw new Error("Wheel zoom must ignore hidden Reading-view instances and keep Write zoom alive.");
}

function rendererHostIsWritable(el) {
  return !!el?.closest(".markdown-source-view");
}

const sourceHost = { closest: (selector) => selector === ".markdown-source-view" ? {} : null };
const previewHost = { closest: (selector) => selector === ".markdown-preview-view" ? {} : null };

if (!rendererHostIsWritable(sourceHost)) throw new Error("A Live Preview / source-view host must stay writable.");
if (rendererHostIsWritable(previewHost)) throw new Error("A Reading-view host must not be treated as writable.");
if (rendererHostIsWritable(null) || rendererHostIsWritable(undefined)) throw new Error("Missing hosts must not be writable.");

console.log("Renderer Read/Write lifecycle invariants verified.");
