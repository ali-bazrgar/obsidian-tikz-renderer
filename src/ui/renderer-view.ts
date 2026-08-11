import { App, Modal, Notice, setIcon } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";

export class TikzRendererView {
  constructor(
    private readonly app: App,
    private readonly exportService: ExportService,
    private readonly host: HTMLElement,
    private readonly result: RenderResult,
    private readonly source: string,
    private readonly service: RenderService,
    private readonly kind: RenderResult["kind"],
    private readonly history: TikzHistoryStore,
    private readonly historyKey: string,
    private readonly editSource: (source: string) => Promise<void>,
  ) {}

  render(): void {
    this.host.empty();
    const root = this.host.createDiv({ cls: "tikz-renderer" });
    root.dataset.theme = this.detectTheme();

    const toolbar = root.createDiv({ cls: "tikz-renderer-toolbar" });
    toolbar.createSpan({ text: "TikZ Renderer", cls: "tikz-renderer-title" });
    const menu = toolbar.createEl("button", { cls: "tikz-renderer-menu", attr: { "aria-label": "TikZ controls", type: "button" } });
    setIcon(menu, "more-vertical");

    const canvas = root.createDiv({ cls: "tikz-renderer-canvas" });
    const viewport = canvas.createDiv({ cls: "tikz-renderer-viewport" });
    const img = viewport.createEl("img", { cls: "tikz-renderer-svg", attr: { alt: "TikZ diagram", draggable: "false" } });
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.result.svg)}`;

    let zoom = 1;
    let x = 0;
    let y = 0;
    const apply = (): void => {
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
    };

    const panel = root.createDiv({ cls: "tikz-renderer-panel" });
    panel.hidden = true;
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      panel.hidden = !panel.hidden;
    });

    const button = (label: string, action: () => void | Promise<void>): void => {
      const el = panel.createEl("button", { text: label, attr: { type: "button" } });
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        void action();
      });
    };

    button("−", () => { zoom = Math.max(0.25, zoom - 0.25); apply(); });
    button("Reset", () => { zoom = 1; x = 0; y = 0; apply(); });
    button("+", () => { zoom = Math.min(5, zoom + 0.25); apply(); });
    button("Fit", () => {
      const width = viewport.clientWidth;
      if (width > 0 && img.naturalWidth > 0) zoom = Math.min(1, width / img.naturalWidth);
      x = 0; y = 0; apply();
    });
    button("Edit", () => new TikzSourceModal(this.app, this.source, async (next) => this.editSource(next)).open());
    button("History", () => this.showHistory(panel));
    button("Copy source", async () => { await navigator.clipboard.writeText(this.source); new Notice("TikZ source copied."); });
    button("Copy embed", async () => { await navigator.clipboard.writeText(`\`\`\`${this.kind}\n${this.source}\n\`\`\``); new Notice("TikZ embed copied."); });
    button("Export SVG", async () => { try { await this.exportService.saveSvg(this.result.svg, this.result.hash); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } });
    button("Export PNG", async () => { try { await this.exportService.savePng(this.result.svg, this.result.hash); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } });
    button("Re-render", async () => {
      try {
        const next = await this.service.render(this.source, this.kind);
        this.result.svg = next.svg;
        this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      }
    });

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || panel.contains(event.target as Node) || menu.contains(event.target as Node)) return;
      dragging = true; lastX = event.clientX; lastY = event.clientY;
      viewport.classList.add("is-dragging"); viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      x += event.clientX - lastX; y += event.clientY - lastY;
      lastX = event.clientX; lastY = event.clientY; apply();
    });
    const stopDragging = (): void => { dragging = false; viewport.classList.remove("is-dragging"); };
    viewport.addEventListener("pointerup", stopDragging);
    viewport.addEventListener("pointercancel", stopDragging);
    viewport.addEventListener("lostpointercapture", stopDragging);

    // Obsidian's CSS changes globally when the theme changes. Do not create a
    // MutationObserver per renderer: dozens of TikZ blocks would otherwise
    // create dozens of long-lived observers. Theme colors are inherited from
    // Obsidian CSS, so a renderer only needs its initial semantic marker.
    img.addEventListener("load", () => { img.dataset.tikzTheme = this.detectTheme(); }, { once: true });
    apply();
  }

  private showHistory(panel: HTMLElement): void {
    panel.empty();
    const heading = panel.createDiv({ cls: "tikz-history-heading", text: "History" });
    heading.createEl("button", { text: "Close", attr: { type: "button" } }).addEventListener("click", () => panel.empty());
    const entries = this.history.list(this.historyKey);
    if (entries.length === 0) { panel.createDiv({ text: "No previous versions yet." }); return; }
    entries.forEach((entry, index) => {
      const row = panel.createDiv({ cls: "tikz-history-row" });
      row.createSpan({ text: `Version ${entries.length - index}` });
      row.createSpan({ text: new Date(entry.timestamp).toLocaleString() });
      if (entry.source !== this.source) {
        row.createEl("button", { text: "Restore", attr: { type: "button" } }).addEventListener("click", () =>
          new TikzSourceModal(this.app, entry.source, async (next) => this.editSource(next)).open());
      }
    });
  }

  private detectTheme(): string {
    const classes = document.body.classList;
    if (classes.contains("theme-dark")) return "dark";
    if (classes.contains("theme-light")) return "light";
    return "obsidian";
  }
}

class TikzSourceModal extends Modal {
  constructor(app: App, private readonly initialSource: string, private readonly onRender: (source: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText("TikZ Source");
    const editor = this.contentEl.createEl("textarea", { cls: "tikz-source-editor" });
    editor.value = this.initialSource; editor.spellcheck = false;
    const actions = this.contentEl.createDiv({ cls: "tikz-source-actions" });
    actions.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "Render", attr: { type: "button" } }).addEventListener("click", async () => {
      try { await this.onRender(editor.value); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
    });
    window.setTimeout(() => editor.focus(), 0);
  }
}
