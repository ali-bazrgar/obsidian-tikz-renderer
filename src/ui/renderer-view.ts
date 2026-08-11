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
    const doc = this.host.ownerDocument;
    const root = this.host.createDiv({ cls: "tikz-renderer" });
    root.dataset.theme = this.detectTheme();

    // Controls deliberately live outside the paper/figure surface. They must
    // never cover, clip, or participate in the SVG's layout.
    const controls = root.createDiv({ cls: "tikz-renderer-controls" });
    const menu = controls.createEl("button", {
      cls: "tikz-renderer-menu",
      attr: { "aria-label": "TikZ controls", "aria-expanded": "false", type: "button" },
    });
    setIcon(menu, "more-horizontal");

    const paper = root.createDiv({ cls: "tikz-renderer-paper" });
    const viewport = paper.createDiv({ cls: "tikz-renderer-viewport" });
    const img = viewport.createEl("img", {
      cls: "tikz-renderer-svg",
      attr: { alt: "TikZ diagram", draggable: "false" },
    });
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.result.svg)}`;

    let zoom = 1;
    let x = 0;
    let y = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const clampZoom = (value: number): number => Math.min(5, Math.max(0.25, value));
    const apply = (): void => {
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
      img.dataset.zoom = `${Math.round(zoom * 100)}%`;
    };
    const resetView = (): void => { zoom = 1; x = 0; y = 0; apply(); };
    const fit = (): void => {
      const availableWidth = Math.max(1, viewport.clientWidth - 28);
      const availableHeight = Math.max(1, viewport.clientHeight - 28);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        zoom = clampZoom(Math.min(1, availableWidth / img.naturalWidth, availableHeight / img.naturalHeight));
      } else {
        zoom = 1;
      }
      x = 0;
      y = 0;
      apply();
    };

    const panel = doc.createDiv({ cls: "tikz-renderer-panel" });
    panel.hidden = true;
    panel.setAttribute("role", "menu");
    doc.body.appendChild(panel);

    const positionPanel = (): void => {
      const rect = menu.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const gap = 6;
      let left = rect.left;
      let top = rect.bottom + gap;
      if (left + panelRect.width > doc.documentElement.clientWidth - 8) left = Math.max(8, doc.documentElement.clientWidth - panelRect.width - 8);
      if (top + panelRect.height > doc.documentElement.clientHeight - 8) top = Math.max(8, rect.top - panelRect.height - gap);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const closePanel = (): void => {
      panel.hidden = true;
      menu.setAttribute("aria-expanded", "false");
    };
    const togglePanel = (): void => {
      panel.hidden = !panel.hidden;
      menu.setAttribute("aria-expanded", `${!panel.hidden}`);
      if (!panel.hidden) {
        positionPanel();
        panel.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };

    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePanel();
    });

    const button = (label: string, action: () => void | Promise<void>): void => {
      const el = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitem" } });
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        void action();
      });
    };

    button("Zoom −", () => { zoom = clampZoom(zoom - 0.25); apply(); });
    button("Zoom +", () => { zoom = clampZoom(zoom + 0.25); apply(); });
    button("Reset view", resetView);
    button("Fit", fit);
    button("Edit source", () => new TikzSourceModal(this.app, this.source, async (next) => this.editSource(next)).open());
    button("History", () => this.showHistory(panel));
    button("Re-render", async () => {
      try {
        const next = await this.service.render(this.source, this.kind);
        this.result.svg = next.svg;
        closePanel();
        this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      }
    });
    button("Copy source", async () => { await navigator.clipboard.writeText(this.source); new Notice("TikZ source copied."); });
    button("Copy embed", async () => { await navigator.clipboard.writeText(`\`\`\`${this.kind}\n${this.source}\n\`\`\``); new Notice("TikZ embed copied."); });
    button("Export SVG", async () => { try { await this.exportService.saveSvg(this.result.svg, this.result.hash); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } });
    button("Export PNG", async () => { try { await this.exportService.savePng(this.result.svg, this.result.hash); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } });

    const onDocumentPointerDown = (event: PointerEvent): void => {
      if (panel.hidden || panel.contains(event.target as Node) || menu.contains(event.target as Node)) return;
      closePanel();
    };
    doc.addEventListener("pointerdown", onDocumentPointerDown, true);

    const onViewportPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.classList.add("is-dragging");
      viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const onViewportPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      x += event.clientX - lastX;
      y += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      apply();
      event.preventDefault();
    };
    const stopDragging = (): void => {
      dragging = false;
      viewport.classList.remove("is-dragging");
    };

    viewport.addEventListener("pointerdown", onViewportPointerDown);
    viewport.addEventListener("pointermove", onViewportPointerMove);
    viewport.addEventListener("pointerup", stopDragging);
    viewport.addEventListener("pointercancel", stopDragging);
    viewport.addEventListener("lostpointercapture", stopDragging);

    // Wheel zoom is intentionally local to the figure. Once zoomed, drag/pan
    // works with the same pointer gesture and does not depend on the menu.
    viewport.addEventListener("wheel", (event) => {
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextZoom = clampZoom(zoom * factor);
      if (nextZoom === zoom) return;
      const rect = viewport.getBoundingClientRect();
      const px = event.clientX - (rect.left + rect.width / 2);
      const py = event.clientY - (rect.top + rect.height / 2);
      const ratio = nextZoom / zoom;
      x = px - (px - x) * ratio;
      y = py - (py - y) * ratio;
      zoom = nextZoom;
      apply();
      event.preventDefault();
    }, { passive: false });

    const onResize = (): void => { if (!panel.hidden) positionPanel(); };
    doc.defaultView?.addEventListener("resize", onResize);
    doc.defaultView?.addEventListener("scroll", onResize, true);

    const cleanup = (): void => {
      doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
      doc.defaultView?.removeEventListener("resize", onResize);
      doc.defaultView?.removeEventListener("scroll", onResize, true);
      panel.remove();
    };
    root.addEventListener("DOMNodeRemoved", (event) => {
      if (event.target === root) cleanup();
    }, { once: true });

    img.addEventListener("load", () => { fit(); }, { once: true });
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
    const classes = this.host.ownerDocument.body.classList;
    if (classes.contains("theme-dark")) return "dark";
    if (classes.contains("theme-light")) return "light";
    return "obsidian";
  }
}

class TikzSourceModal extends Modal {
  constructor(app: App, private readonly initialSource: string, private readonly onRender: (source: string) => Promise<void>) { super(app); }
  onOpen(): void {
    // Keep the editor visually quiet: the source itself is the UI.
    this.titleEl.empty();
    this.contentEl.empty();
    const editor = this.contentEl.createEl("textarea", { cls: "tikz-source-editor" });
    editor.value = this.initialSource;
    editor.spellcheck = false;
    const actions = this.contentEl.createDiv({ cls: "tikz-source-actions" });
    actions.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "Render", attr: { type: "button" } }).addEventListener("click", async () => {
      try { await this.onRender(editor.value); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
    });
    window.setTimeout(() => editor.focus(), 0);
  }
}
