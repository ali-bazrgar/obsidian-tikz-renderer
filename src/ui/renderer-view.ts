import { App, Modal, Notice } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { DisplayTheme, TikzSettings } from "../settings/settings";

export class TikzRendererView {
  constructor(
    private readonly app: App,
    private readonly exportService: ExportService,
    private readonly host: HTMLElement,
    private readonly result: RenderResult,
    private readonly source: string,
    private readonly sourcePath: string,
    private readonly service: RenderService,
    private readonly kind: RenderResult["kind"],
    private readonly history: TikzHistoryStore,
    private readonly historyKey: string,
    private readonly editSource: (source: string) => Promise<void>,
    private readonly getSettings: () => TikzSettings,
    private readonly saveSettings: (settings: TikzSettings) => Promise<void>,
  ) {}

  render(): void {
    this.host.empty();
    const shell = this.host.createDiv({ cls: "tikz-renderer-shell" });
    const controls = shell.createDiv({ cls: "tikz-renderer-controls" });
    const menu = controls.createEl("button", {
      cls: "tikz-renderer-menu",
      attr: { "aria-label": "TikZ controls", "aria-expanded": "false", type: "button", title: "TikZ controls" },
    });
    menu.textContent = "⋯";

    const panel = shell.createDiv({ cls: "tikz-renderer-panel" });
    panel.hidden = true;
    panel.setAttribute("role", "menu");

    const paper = shell.createDiv({ cls: "tikz-renderer-paper" });
    const viewport = paper.createDiv({ cls: "tikz-renderer-viewport" });
    const assetLink = viewport.createEl("a", {
      cls: "tikz-renderer-asset-link",
      attr: { href: "#", "aria-label": "Open TikZ SVG asset", title: "Open rendered SVG" },
    });
    const img = assetLink.createEl("img", {
      cls: "tikz-renderer-svg",
      attr: { alt: "TikZ diagram", draggable: "false" },
    });
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.result.svg)}`;
    assetLink.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.result.assetPath) this.app.workspace.openLinkText(this.result.assetPath, this.sourcePath, false);
    });

    let zoom = Math.min(5, Math.max(0.25, this.getSettings().defaultZoom / 100));
    let x = 0;
    let y = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let panStartX = 0;
    let panStartY = 0;

    const clampZoom = (value: number): number => Math.min(5, Math.max(0.25, value));
    const apply = (): void => {
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
      img.dataset.zoom = `${Math.round(zoom * 100)}%`;
      viewport.classList.toggle("is-pannable", zoom > 1);
    };
    const resetView = (): void => {
      zoom = Math.min(5, Math.max(0.25, this.getSettings().defaultZoom / 100));
      x = 0;
      y = 0;
      apply();
    };
    const fit = (): void => {
      const availableWidth = Math.max(1, viewport.clientWidth - 20);
      const availableHeight = Math.max(1, viewport.clientHeight - 20);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        zoom = clampZoom(Math.min(1, availableWidth / img.naturalWidth, availableHeight / img.naturalHeight));
      } else zoom = 1;
      x = 0;
      y = 0;
      apply();
    };

    const closePanel = (): void => {
      panel.hidden = true;
      menu.setAttribute("aria-expanded", "false");
    };
    menu.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      panel.hidden = !panel.hidden;
      menu.setAttribute("aria-expanded", `${!panel.hidden}`);
    });
    document.addEventListener("click", (event) => {
      if (panel.hidden || panel.contains(event.target as Node) || menu.contains(event.target as Node)) return;
      closePanel();
    }, { capture: true });

    const addButton = (label: string, action: () => void | Promise<void>): HTMLButtonElement => {
      const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitem" } });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void action();
      });
      return button;
    };

    addButton("Zoom −", () => { zoom = clampZoom(zoom - 0.25); apply(); });
    addButton("Zoom +", () => { zoom = clampZoom(zoom + 0.25); apply(); });
    addButton("Reset view", resetView);
    addButton("Fit", fit);
    addButton("Theme", () => this.renderThemeMenu(panel, closePanel));
    addButton("Edit source", () => new TikzSourceModal(this.app, this.source, async (next) => this.editSource(next)).open());
    addButton("History", () => this.showHistory(panel));
    addButton("Re-render", async () => {
      try {
        const next = await this.service.render(this.source, this.kind);
        this.result.svg = next.svg;
        this.result.hash = next.hash;
        this.result.engine = next.engine;
        this.result.fromCache = next.fromCache;
        closePanel();
        this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      }
    });
    addButton("Copy source", async () => { await navigator.clipboard.writeText(this.source); new Notice("TikZ source copied."); });
    addButton("Copy embed", async () => { await navigator.clipboard.writeText(`\`\`\`${this.kind}\n${this.source}\n\`\`\``); new Notice("TikZ embed copied."); });
    addButton("Export SVG", async () => {
      try {
        const path = await this.exportService.saveSvg(this.result.svg, this.result.hash, this.sourcePath);
        this.result.assetPath = path;
        this.showAssetLink(panel, "SVG", path);
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
    });
    addButton("Export PNG", async () => {
      try {
        const path = await this.exportService.savePng(this.result.svg, this.result.hash, this.sourcePath);
        this.showAssetLink(panel, "PNG", path);
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
    });

    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || zoom <= 1 || (event.target as HTMLElement).closest("a") === null) return;
      dragging = true;
      panStartX = x;
      panStartY = y;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.classList.add("is-dragging");
      viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      x += event.clientX - lastX;
      y += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      apply();
      event.preventDefault();
    });
    const stopDragging = (): void => {
      if (!dragging) return;
      dragging = false;
      viewport.classList.remove("is-dragging");
      if (Math.abs(x - panStartX) < 3 && Math.abs(y - panStartY) < 3 && this.result.assetPath) {
        this.app.workspace.openLinkText(this.result.assetPath, this.sourcePath, false);
      }
    };
    viewport.addEventListener("pointerup", stopDragging);
    viewport.addEventListener("pointercancel", stopDragging);
    viewport.addEventListener("lostpointercapture", stopDragging);

    viewport.addEventListener("wheel", (event) => {
      const nextZoom = clampZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
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

    img.addEventListener("load", () => { if (zoom === 1) fit(); }, { once: true });
    this.applyTheme(shell);
    this.installThemeObserver(shell);
    apply();
  }

  private renderThemeMenu(panel: HTMLElement, closePanel: () => void): void {
    panel.empty();
    const title = panel.createDiv({ cls: "tikz-renderer-panel-title", text: "Theme" });
    title.setAttribute("role", "heading");
    const themes: Array<[DisplayTheme, string]> = [
      ["auto", "Auto"], ["obsidian", "Obsidian"], ["light", "Light"], ["paper", "Paper"],
      ["dark", "Dark"], ["contrast", "Contrast"], ["bw", "Black & white"], ["custom", "Custom"],
    ];
    for (const [theme, label] of themes) {
      const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitemradio", "aria-checked": `${this.getSettings().displayTheme === theme}` } });
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const settings = { ...this.getSettings(), displayTheme: theme };
        await this.saveSettings(settings);
        closePanel();
        this.render();
      });
    }
    const custom = this.getSettings();
    if (custom.displayTheme === "custom") {
      const color = panel.createEl("input", { attr: { type: "color", value: custom.customBackgroundColor, "aria-label": "Custom background color" } });
      color.addEventListener("change", async () => {
        await this.saveSettings({ ...this.getSettings(), customBackgroundColor: color.value });
        this.applyTheme(this.host);
      });
      const opacity = panel.createEl("input", { attr: { type: "range", min: "10", max: "100", step: "1", value: `${custom.customBackgroundOpacity}`, "aria-label": "Custom background opacity" } });
      opacity.addEventListener("input", () => {
        const value = Number(opacity.value);
        this.host.style.setProperty("--tikz-custom-bg-opacity", `${value / 100}`);
      });
      opacity.addEventListener("change", async () => {
        await this.saveSettings({ ...this.getSettings(), customBackgroundOpacity: Number(opacity.value) });
      });
    }
  }

  private applyTheme(element: HTMLElement): void {
    const settings = this.getSettings();
    const theme = settings.displayTheme === "auto" ? this.detectTheme() : settings.displayTheme;
    element.dataset.theme = theme;
    if (theme === "custom") {
      element.style.setProperty("--tikz-custom-bg", settings.customBackgroundColor);
      element.style.setProperty("--tikz-custom-bg-opacity", `${settings.customBackgroundOpacity / 100}`);
    } else {
      element.style.removeProperty("--tikz-custom-bg");
      element.style.removeProperty("--tikz-custom-bg-opacity");
    }
  }

  private installThemeObserver(element: HTMLElement): void {
    if (this.getSettings().displayTheme !== "auto") return;
    const documentRoot = this.host.ownerDocument.documentElement;
    const observer = new MutationObserver(() => this.applyTheme(element));
    observer.observe(documentRoot, { attributes: true, attributeFilter: ["class"] });
    this.host.addEventListener("DOMNodeRemoved", () => observer.disconnect(), { once: true });
  }

  private showAssetLink(panel: HTMLElement, type: string, path: string): void {
    const links = panel.createDiv({ cls: "tikz-renderer-asset-links" });
    const link = links.createEl("a", { text: `${type}: ${path}`, attr: { href: "#" } });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.app.workspace.openLinkText(path, this.sourcePath, false);
    });
  }

  private showHistory(panel: HTMLElement): void {
    panel.empty();
    panel.createDiv({ cls: "tikz-renderer-panel-title", text: "History" });
    const entries = this.history.list(this.historyKey);
    if (entries.length === 0) { panel.createDiv({ text: "No previous versions yet." }); return; }
    entries.forEach((entry, index) => {
      const row = panel.createDiv({ cls: "tikz-history-row" });
      row.createSpan({ text: `Version ${entries.length - index}` });
      row.createSpan({ text: new Date(entry.timestamp).toLocaleString() });
      if (entry.source !== this.source) row.createEl("button", { text: "Restore", attr: { type: "button" } }).addEventListener("click", () => new TikzSourceModal(this.app, entry.source, async (next) => this.editSource(next)).open());
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
    editor.focus();
  }
}
