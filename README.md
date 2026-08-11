# TikZ Renderer for Obsidian

A desktop-first Obsidian plugin for rendering **TikZ/PGF, PGFPlots, circuitikz, and general LaTeX graphics** directly inside your notes using a local **TeX Live** installation.

The plugin compiles your code locally and renders the result as a real SVG inside Obsidian. It is designed for people who want high-quality mathematical diagrams, scientific figures, circuits, plots, geometry, and custom LaTeX graphics without relying on an online renderer.

## ✨ Features

- Render `tikz`, `pgfplots`, `circuitikz`, `tex`, and `latex` code blocks.
- Local compilation through your installed TeX distribution.
- Direct vector SVG rendering for sharp diagrams at any zoom level.
- Automatic engine selection.
- XeLaTeX support for **Persian/Arabic text**, `fontspec`, and `xepersian`.
- Support for classic LaTeX/DVI, XeLaTeX/XDV, PDF-based engines, and `dvilualatex`.
- Per-figure controls from the **three-dot menu**.
- Real SVG zoom with **Ctrl + mouse wheel**.
- Pan support for zoomed figures.
- Figure-specific settings instead of global rendering controls.
- Custom background/theme options without changing the SVG's actual opacity.
- PNG export from the current figure viewport.
- PNG exports preserve the current figure position, zoom, pan, viewport size, and active appearance.
- PNG exports are stored in a dedicated `PNG` folder next to the configured SVG assets.
- Repeated PNG exports create new files instead of overwriting previous snapshots.
- Content-addressed SVG caching for faster repeated renders.
- Concurrent requests for the same render share one compilation task.
- Unique temporary compilation directories with automatic cleanup.
- Optional **Keep TeX source** setting for debugging.
- No private CodeMirror runtime is injected into Obsidian's editor.

## 📋 Requirements

### End users

- **Obsidian 1.8.7 or newer**
- **Obsidian Desktop**
- **TeX Live** installed on the computer
- `dvisvgm` available on PATH or configured explicitly
- `mutool` only when using an engine that produces PDF output (`pdflatex` / `lualatex`)

The default LaTeX/DVI and XeLaTeX/XDV pipelines do **not** require Ghostscript or MuPDF.

> This is a desktop plugin because it runs local TeX executables. It is not intended for Obsidian Mobile.

## 🚀 Installation

### Manual installation

1. Install **TeX Live** on your computer.
2. Make sure the required TeX executables are available, or prepare their full paths.
3. Build/download the plugin files:
   - `main.js`
   - `manifest.json`
   - `styles.css`
4. Create the plugin folder:

   ```text
   <Vault>/.obsidian/plugins/obsidian-tikz-renderer/
   ```

5. Put the three plugin files inside that folder.
6. Open **Obsidian → Settings → Community plugins**.
7. Enable **TikZ Renderer**.

## 🧰 TeX Live setup

The plugin does **not** require TeX Live to be installed at one hard-coded location such as `D:\texlive\2025`.

It can detect TeX executables from the system `PATH` and supports TeX Live installations located on different drives and in different installation directories.

Open the plugin settings and use:

**Detect TeX Live executables**

Then use:

**Test TeX installation**

The test reports the detected executable paths and whether each required tool is working.

### Typical Windows installation

A standard TeX Live installation may look like:

```text
C:\texlive\2026\bin\windows\
```

Another user may have, for example:

```text
D:\texlive\2025\bin\windows\
```

or a completely different installation directory.

The plugin should not depend on the drive letter or a particular TeX Live year.

### Required executables

Depending on the selected engine, the plugin can use:

```text
latex
pdflatex
xelatex
lualatex
dvilualatex
dvisvgm
mutool
```

`mutool` is needed only for PDF-based conversion paths.

If an executable cannot be detected automatically, configure its full path in the plugin settings.

## 📝 Basic usage

Create a fenced code block with the `tikz` language:

````markdown
```tikz
\begin{tikzpicture}
  \draw[->] (0,0) -- (4,0) node[right] {$x$};
  \draw[->] (0,0) -- (0,3) node[above] {$y$};
  \draw[blue, thick] (0,0) circle (1);
  \draw[red, thick] (0,0) -- (3,2);
\end{tikzpicture}
```
````

The plugin compiles the block and inserts the resulting vector figure into the note.

## 📦 Supported code fences

The following fenced block names are supported:

```text
tikz
pgfplots
circuitikz
tex
latex
```

For example:

````markdown
```pgfplots
\begin{tikzpicture}
\begin{axis}[
    xlabel={$x$},
    ylabel={$y$}
]
\addplot[blue, thick] {x^2};
\end{axis}
\end{tikzpicture}
```
````

## 🌐 Persian and Arabic text

When **Auto** engine selection is enabled, the plugin detects situations that require XeLaTeX, including:

- Persian text
- Arabic text
- `fontspec`
- `xepersian`

For example:

````markdown
```tikz
\documentclass{article}
\usepackage{xepersian}
\settextfont{Amiri}
\begin{document}

\begin{tikzpicture}
  \node[draw, rounded corners, fill=blue!10, inner sep=8pt]
    {سلام دنیا};
\end{tikzpicture}

\end{document}
```
````

The exact font must of course be installed and available to your TeX Live installation.

## ⚙️ Rendering engines

The **Auto** mode chooses an appropriate pipeline:

| Situation | Engine/pipeline |
|---|---|
| Normal TikZ/LaTeX | LaTeX → DVI → SVG |
| Persian/Arabic text | XeLaTeX → XDV → SVG |
| `fontspec` / `xepersian` | XeLaTeX → XDV → SVG |
| Explicit PDF engine | PDF → SVG |

Explicit engines are available for:

```text
latex
pdflatex
xelatex
lualatex
dvilualatex
```

The plugin uses `dvisvgm` for direct DVI/XDV-to-SVG conversion where applicable. This keeps the normal vector rendering path independent of the PDF/Ghostscript compatibility chain.

## 🔍 Figure controls

Each rendered figure has its own controls.

Use the **three-dot button** associated with the figure to open its settings panel.

Depending on the current mode and configuration, the panel provides controls such as:

- Zoom
- Pan
- Figure appearance/theme
- Background options
- PNG export

The controls belong to the individual figure rather than changing every TikZ figure in the vault.

### Zoom

In the figure area:

**Ctrl + mouse wheel** → zoom the actual SVG figure.

After zooming, the figure can be panned so that you can inspect different parts of a large diagram.

## 🖼️ PNG export

PNG export is available from the figure's **three-dot settings panel in Edit mode**.

The important difference from exporting the raw SVG is that PNG export captures the **current viewport**.

That means the exported image represents what is inside the figure's visible box at that moment, including:

- Current viewport width and height
- Current zoom
- Current pan position
- Current figure position
- Current appearance/background

The PNG is not intentionally rendered at 2× or another arbitrary scale. Its pixel dimensions correspond to the current viewport dimensions.

### PNG storage

PNG files are stored in a dedicated folder named:

```text
PNG
```

under the same configured asset location used for SVG files.

Previous PNG snapshots are preserved. A new export does not replace the previous snapshot; subsequent exports receive a new filename.

This makes it possible to capture several different zoom/pan states of the same TikZ figure.

## 🎨 Appearance and themes

The figure controls can change the appearance/background of an individual rendered figure.

Custom background opacity affects the **figure background only**. It does not make the SVG itself translucent.

The rendered figure and its controls use styling intended to remain visually consistent with Obsidian's interface.

## 💾 SVG cache

Rendered SVGs are cached using a content-addressed SHA-256 key.

The cache key includes relevant rendering inputs such as:

- Source code
- Code-block type
- Selected engine
- Executable
- Output format
- Preamble
- Persian font configuration
- Converter paths
- Rendering pipeline version

As a result, unchanged figures can be reused without unnecessarily recompiling the same TeX source.

## 🔒 Security and process execution

Compiler processes are started with Node's `execFile` and argument arrays rather than constructing shell command strings.

The rendering pipeline uses:

```text
-no-shell-escape
```

for TeX compilation.

This is intended to keep the local compilation process more predictable and avoid unnecessary shell interpretation.

## 🧹 Temporary files

Each compilation uses its own temporary working directory.

Temporary compilation files are cleaned up automatically after rendering unless **Keep TeX source** is enabled.

Keeping the source can be useful when diagnosing a TeX compilation problem.

## 🛠️ Troubleshooting

### TeX Live is not detected

Open the plugin settings and run:

**Detect TeX Live executables**

Then run:

**Test TeX installation**

If detection still fails, configure the executable paths manually.

Also verify that the corresponding TeX Live `bin` directory is available on your system `PATH`.

### A TeX package is missing

The plugin uses the packages installed in your local TeX Live distribution.

Install the missing package through TeX Live and render the figure again.

If you installed the complete TeX Live distribution, most standard TikZ/PGF packages should already be available.

### `dvisvgm` is missing

Install/configure `dvisvgm` and make sure the executable can be found through PATH or the plugin's executable settings.

### `mutool` is missing

`mutool` is only required for PDF-output engines such as `pdflatex` and `lualatex`.

The normal LaTeX/DVI and XeLaTeX/XDV paths do not require it.

### Persian/Arabic text does not render

Use **Auto** or explicitly select XeLaTeX.

Check that:

1. `xelatex` is correctly configured.
2. `xepersian`/required packages are installed.
3. The selected Persian/Arabic font is installed and recognized by TeX Live.

### The figure is too large

Use Ctrl + mouse wheel to zoom out or use the figure controls to adjust the current view.

### PNG looks different from the visible figure

PNG export is designed to capture the current viewport. Before exporting, make sure the figure has the exact zoom, pan, viewport size, and appearance you want.

## 💻 Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/ali-bazrgar/obsidian-tikz-renderer.git
cd obsidian-tikz-renderer
npm ci
```

Type-check the project:

```bash
npm run typecheck
```

Build the production plugin:

```bash
npm run build
```

The generated production files are the files required for a manual Obsidian installation.

## 🏗️ Architecture overview

The plugin is intentionally split into rendering, executable detection, caching, export, and UI responsibilities.

At a high level:

```text
Markdown code block
        │
        ▼
   TikZ Renderer
        │
        ├── Engine detection
        │
        ├── TeX Live executable detection
        │
        ├── Local TeX compilation
        │
        ├── DVI/XDV/PDF conversion
        │
        ├── SVG cache
        │
        ▼
   Inline SVG figure
        │
        ├── Zoom
        ├── Pan
        ├── Appearance
        └── PNG viewport export
```

## 🧩 CodeMirror compatibility

The production plugin intentionally does **not** register a private CodeMirror extension.

This avoids loading a second `@codemirror/state` / `@codemirror/view` runtime alongside Obsidian's own editor runtime, which can cause errors such as:

```text
Unrecognized extension value in extension set
```

The rendering core and Reading Mode therefore remain independent of CodeMirror.

## 📄 License

See the repository for the current license and project metadata.

## 👤 Author

Created and maintained by **Ali Bazrgar**.

Repository: https://github.com/ali-bazrgar/obsidian-tikz-renderer
