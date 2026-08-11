# TikZ Renderer

Desktop Obsidian plugin for rendering TikZ/PGF, PGFPlots, circuitikz and LaTeX code blocks with a local TeX installation.

## Requirements
- Obsidian 1.8.7+
- TeX Live
- `dvisvgm` on PATH or configured explicitly
- `mutool` optional
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

## Auto engine
Arabic/Persian text, `fontspec`, or `xepersian` selects XeLaTeX. Otherwise Auto uses PDFLaTeX. Explicit engines are available for `latex`, `pdflatex`, `xelatex`, `lualatex`, and `dvilualatex`.

## Cache and concurrency
The SVG cache is content-addressed with SHA-256 over source, block kind, engine, executable, preamble, Persian font, converter path and pipeline version. Concurrent requests for the same hash share one Promise. Compilation uses unique temporary directories and cleans them unless **Keep TeX source** is enabled.

## Troubleshooting
Errors include executable failures, timeouts, permission errors, converter failures, and the relevant TeX log. The full diagnostic is also written to the developer console. Missing packages should be installed through TeX Live; missing executables should be added to PATH or configured by full path.

## CodeMirror / Live Preview
The renderer core deliberately has no direct CodeMirror dependencies, preventing duplicate `@codemirror/state`, `@codemirror/view`, or `@codemirror/language` instances from entering the bundle. Live Preview integration is being treated as a separate compatibility layer and will only use Obsidian-supported editor extension APIs; this initial foundation does not inject block decorations through a `ViewPlugin`.
