import { App, Modal, Notice } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { DisplayTheme, TikzSettings } from "../settings/settings";

export class TikzRendererView {
  private cleanup: (() => void) | undefined;

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
    this.cleanup?.();
    this.cleanup = undefined;
    this.host.empty();

    const shell = this.host.createDiv({ cls: "tikz-renderer-shell" });
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

    // The controls are deliberately portaled to <body>. They are never clipped by
    // the figure's width/height/overflow and therefore remain fully usable.
    const controls = this.host.ownerDocument.body.createDiv({ cls: "tikz-renderer-controls" });
    const menu = controls.createEl("button", {
      cls: "tikz-renderer-menu",
      attr: { "aria-label": "TikZ controls", "aria-expanded": "false", type: "button", title: "TikZ controls" },
    });
    menu.textContent = "⋯";

    const panel = this.host.ownerDocument.body.createDiv({ cls: "tikz-renderer-panel" });
    panel.hidden = true;
    panel.setAttribute("role", "menu");

    let zoom = Math.min(5, Math.max(0.25, this.getSettings().defaultZoom / 100));
    let x = 0;
    let y = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const clampZoom = (value: number): number => Math.min(5, Math.max(0.25, value));
    const apply = (): void => {
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
      img.dataset.zoom = `${Math.round(zoom * 100)}%`;
      viewport.classList.toggle("is-pannable", zoom > 1);
      viewport.classList.toggle("is-zoomed", zoom !== 1);
    };

    const resetView = (): void => {
      zoom = Math.min(5, Math.max(0.25, this.getSettings().defaultZoom / 100));
      x = 0;
      y = 0;
      apply();
    };

    const fit = (): void => {
      const availableWidth = Math.max(1, this.host.clientWidth - 16);
      const naturalWidth = img.naturalWidth || img.getBoundingClientRect().width;
      if (naturalWidth > 0) zoom = clampZoom(Math.min(1, availableWidth / naturalWidth));
      x = 0;
      y = 0;
      apply();
    };

    const closePanel = (): void => {
      panel.hidden = true;
      menu.setAttribute("aria-expanded", "false");
    };

    const positionControls = (): void => {
      const rect = shell.getBoundingClientRect();
      controls.style.left = `${Math.max(4, rect.left - 24)}px`;
      controls.style.top = `${rect.top + 1}px`;
    };

    const positionPanel = (): void => {
      const buttonRect = menu.getBoundingClientRect();
      const panelWidth = Math.min(340, Math.max(190, panel.offsetWidth || 240));
      const panelHeight = panel.offsetHeight || 240;
      const gap = 6;
      let left = buttonRect.right + gap;
      let top = buttonRect.top;
      if (left + panelWidth > window.innerWidth - 8) left = Math.max(8, buttonRect.left - panelWidth - gap);
      if (top + panelHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - panelHeight - 8);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    menu.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      panel.hidden = !panel.hidden;
      menu.setAttribute("aria-expanded", `${!panel.hidden}`);
      if (!panel.hidden) positionPanel();
    });

    const ownerDocument = this.host.ownerDocument;
    const outsideClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panel.hidden || panel.contains(target) || menu.contains(target)) return;
      closePanel();
    };
    ownerDocument.addEventListener("click", outsideClick, true);

    const addButton = (label: string, action: () => void | Promise<void>): void => {
      const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitem" } });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void action();
      });
    };

    addButton("Zoom −", () => { zoom = clampZoom(zoom - 0.25); apply(); });
    addButton("Zoom +", () => { zoom = clampZoom(zoom + 0.25); apply(); });
    addButton("Reset view", resetView);
    addButton("Fit", fit);
    addButton("Theme", () => this.renderThemeMenu(panel, shell, closePanel));
    addButton("Edit source", () => new TikzSourceModal(this.app, this.source, async (next) => this.editSource(next)).open());
    addButton("History", () => this.showHistory(panel));
    addButton("Re-render", async () => {
      try {
        const next = await this.service.render(this.source, this.kind);
        this.result.svg = next.svg;
        this.result.hash = next.hash;
        this.result.engine = next.engine;
        this.result.fromCache = next.fromCache;
        this.result.assetPath = await this.exportService.saveSvg(next.svg, next.hash, this.sourcePath, false);
        closePanel();
        this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      }
    });
    addButton("Copy source", async () => {
      await navigator.clipboard.writeText(this.source);
      new Notice("TikZ source copied.");
    });
    addButton("Copy embed", async () => {
      await navigator.clipboard.writeText(`\`\`\`${this.kind}\n${this.source}\n\`\`\``);
      new Notice("TikZ embed copied.");
    });
    addButton("Export SVG", async () => {
      try {
        const path = await this.exportService.saveSvg(this.result.svg, this.result.hash, this.sourcePath);
        this.result.assetPath = path;
        this.showAssetLink(panel, "SVG", path);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      }
    });
    addButton("Export PNG", async () => {
      try {
        const path = await this.exportService.savePng(this.result.svg, this.result.hash, this.sourcePath);
        this.showAssetLink(panel, "PNG", path);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      }
    });

    assetLink.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!dragging && zoom <= 1 && this.result.assetPath) this.app.workspace.openLinkText(this.result.assetPath, this.sourcePath, false);
    });

    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || zoom <= 1) return;
      dragging = true;
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
      dragging = false;
      viewport.classList.remove("is-dragging");
    };
    viewport.addEventListener("pointerup", stopDragging);
    viewport.addEventListener("pointercancel", stopDragging);
    viewport.addEventListener("lostpointercapture", stopDragging);

    // Only Ctrl/Cmd + wheel changes figure zoom. Ordinary wheel is left untouched
    // so Obsidian keeps its normal document scrolling behavior.
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
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
    };
    viewport.addEventListener("wheel", wheel, { passive: false });

    img.addEventListener("load", () => {
      if (this.getSettings().defaultZoom === 100) fit();
      positionControls();
    }, { once: true });

    const observer = new MutationObserver(() => {
      this.applyTheme(shell);
      positionControls();
      if (!panel.hidden) positionPanel();
    });
    observer.observe(ownerDocument.documentElement, { attributes: true, attributeFilter: ["class"] });

    const resizeObserver = new ResizeObserver(() => {
      positionControls();
      if (!panel.hidden) positionPanel();
    });
    resizeObserver.observe(shell);

    const view = ownerDocument.defaultView;
    const scrollHandler = (): void => {
      positionControls();
      if (!panel.hidden) positionPanel();
    };
    view?.addEventListener("scroll", scrollHandler, true);
    view?.addEventListener("resize", scrollHandler);

    this.applyTheme(shell);
    apply();
    positionControls();

    this.cleanup = () => {
      ownerDocument.removeEventListener("click", outsideClick, true);
      view?.removeEventListener("scroll", scrollHandler, true);
      view?.removeEventListener("resize", scrollHandler);
      observer.disconnect();
      resizeObserver.disconnect();
      controls.remove();
      panel.remove();
      this.cleanup = undefined;
    };
  }

  private renderThemeMenu(panel: HTMLElement, shell: HTMLElement, closePanel: () => void): void {
    panel.empty();
    panel.createDiv({ cls: "tikz-renderer-panel-title", text: "Theme" });
    const themes: Array<[DisplayTheme, string]> = [["auto", "Auto"], ["obsidian", "Obsidian"], ["light", "Light"], ["paper", "Paper"], ["dark", "Dark"], ["contrast", "Contrast"], ["bw", "Black & white"], ["custom", "Custom"]];
    for (const [theme, label] of themes) {
      const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitemradio", "aria-checked": `${this.getSettings().displayTheme === theme}` } });
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.saveSettings({ ...this.getSettings(), displayTheme: theme });
        closePanel();
        this.render();
      });
    }
    if (this.getSettings().displayTheme === "custom") {
      const color = panel.createEl("input", { attr: { type: "color", value: this.getSettings().customBackgroundColor, "aria-label": "Custom background color" } });
      color.addEventListener("change", async () => {
        await this.saveSettings({ ...this.getSettings(), customBackgroundColor: color.value });
        this.applyTheme(shell);
      });
      const opacity = panel.createEl("input", { attr: { type: "range", min: "10", max: "100", step: "1", value: `${this.getSettings().customBackgroundOpacity}`, "aria-label": "Custom background opacity" } });
      opacity.addEventListener("input", () => shell.style.setProperty("--tikz-custom-bg-opacity", `${Number(opacity.value) / 100}`));
      opacity.addEventListener("change", async () => { await this.saveSettings({ ...this.getSettings(), customBackgroundOpacity: Number(opacity.value) }); });
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

  private showAssetLink(panel: HTMLElement, type: string, path: string): void {
    const links = panel.createDiv({ cls: "tikz-renderer-asset-links" });
    const link = links.createEl("a", { text: `${type}: ${path}`, attr: { href: "#" } });
    link.addEventListener("click", (event) => { event.preventDefault(); this.app.workspace.openLinkText(path, this.sourcePath, false); });
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
