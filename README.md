# TikZ Renderer

Desktop Obsidian plugin for rendering TikZ/PGF, PGFPlots, circuitikz and LaTeX code blocks with a local TeX installation.

## Requirements
- Obsidian 1.8.7+
- TeX Live
- `dvisvgm` on PATH or configured explicitly
- `mutool` is required only when an engine produces PDF output (`pdflatex`/`lualatex`); the default and XeLaTeX paths use DVI/XDV and do not require Ghostscript or MuPDF
- Node.js 18+ for development

## Development
```bash
npm ci
npm run typecheck
npm run build
```

## Usage
````markdown
```tikz
\begin{tikzpicture}
  \draw (0,0) -- (3,0);
  \draw (0,0) circle (1);
\end{tikzpicture}
```
````

Supported fences: `tikz`, `pgfplots`, `circuitikz`, `tex`, `latex`.

## TeX configuration
Configure executable paths in Settings or use **Detect TeX Live executables**. **Test TeX installation** reports each executable as OK/FAILED. Compiler processes use Node `execFile` with argument arrays and `-no-shell-escape`; no shell command strings are constructed.

## Vector rendering pipeline
The plugin renders directly to SVG. Auto selects classic LaTeX/DVI for normal TikZ and XeLaTeX/XDV when Persian/Arabic text or `fontspec`/`xepersian` is detected. DVI and XDV are converted directly by `dvisvgm`, avoiding the PDF/Ghostscript compatibility path. Explicit PDF engines use `mutool draw` to convert PDF to SVG.

## Auto engine
Arabic/Persian text, `fontspec`, or `xepersian` selects XeLaTeX. Otherwise Auto uses LaTeX/DVI. Explicit engines are available for `latex`, `pdflatex`, `xelatex`, `lualatex`, and `dvilualatex`.

## Cache and concurrency
The SVG cache is content-addressed with SHA-256 over source, block kind, engine, executable, output format, preamble, Persian font, converter paths and pipeline version. Concurrent requests for the same hash share one Promise. Compilation uses unique temporary directories and cleans them unless **Keep TeX source** is enabled.

## Display and controls
Reading mode keeps each TikZ control instance attached to its Markdown renderer lifecycle. The three-dot control and settings panel are scoped to that figure, close on outside click or Escape, and are removed when the rendered section is destroyed. The figure is an inline SVG DOM element, not a PNG and not an SVG data-URI image. Ctrl+mouse-wheel zooms the actual SVG, with panning available after zooming.

Custom background opacity applies to the figure background only; it does not change the SVG opacity. The figure and controls use rounded borders consistent with Obsidian's UI.

## CodeMirror / Live Preview
The production plugin runtime intentionally does not register a private CodeMirror extension. This avoids loading a second `@codemirror/state`/`@codemirror/view` runtime alongside Obsidian's editor runtime, which can cause the `Unrecognized extension value in extension set` failure. The rendering core and Reading Mode therefore remain independent of CodeMirror.

## Troubleshooting
Errors include executable failures, timeouts, permission errors, converter failures, and the relevant TeX log. Missing packages should be installed through TeX Live; missing executables should be added to PATH or configured by full path.
