import { App, Modal, Notice } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { DisplayTheme, TikzSettings } from "../settings/settings";

export class TikzRendererView {
  private cleanup: (() => void) | undefined;
  private static readonly activeViews = new Map<string, TikzRendererView>();
  private static readonly allViews = new Set<TikzRendererView>();

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
    // Markdown rendering can replace the processor host entirely. The host
    // therefore cannot be the lifecycle identity. historyKey identifies the
    // logical code block and prevents detached fixed controls from surviving a
    // re-render with a new DOM host.
    TikzRendererView.activeViews.get(this.historyKey)?.dispose();
    TikzRendererView.activeViews.set(this.historyKey, this);
    TikzRendererView.allViews.add(this);
    this.dispose();
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

    const body = this.host.ownerDocument.body;
    const controls = body.createDiv({ cls: "tikz-renderer-controls" });
    controls.setAttribute("aria-hidden", "true");
    const menu = controls.createEl("button", {
      cls: "tikz-renderer-menu",
      attr: {
        "aria-label": "TikZ controls",
        "aria-expanded": "false",
        type: "button",
        title: "TikZ controls",
      },
    });
    menu.textContent = "⋯";

    const panel = body.createDiv({ cls: "tikz-renderer-panel" });
    panel.hidden = true;
    panel.setAttribute("role", "menu");

    let zoom = clampZoom(this.getSettings().defaultZoom / 100);
    let naturalWidth = 0;
    let naturalHeight = 0;
    let panX = 0;
    let panY = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const positionControls = (): void => {
      if (!shell.isConnected) {
        controls.hidden = true;
        return;
      }
      const rect = shell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
        controls.hidden = true;
        closePanel();
        return;
      }
      controls.hidden = false;
      controls.style.left = `${Math.max(4, rect.left - 22)}px`;
      controls.style.top = `${Math.max(4, rect.top)}px`;
    };

    const positionPanel = (): void => {
      if (panel.hidden || controls.hidden || !shell.isConnected) return;
      const buttonRect = menu.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const gap = 7;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const width = Math.min(panelRect.width || 240, viewportWidth - 16);
      const height = Math.min(panelRect.height || 240, viewportHeight - 16);

      let left = buttonRect.right + gap;
      if (left + width > viewportWidth - 8) left = buttonRect.left - width - gap;
      left = Math.max(8, Math.min(left, viewportWidth - width - 8));

      let top = buttonRect.top;
      if (top + height > viewportHeight - 8) top = viewportHeight - height - 8;
      top = Math.max(8, top);

      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    };

    const applyTheme = (): void => {
      const settings = this.getSettings();
      const theme = settings.displayTheme === "auto" ? this.detectTheme() : settings.displayTheme;
      shell.dataset.theme = theme;
      if (theme === "custom") {
        shell.style.setProperty("--tikz-custom-bg", settings.customBackgroundColor);
        shell.style.setProperty("--tikz-custom-bg-opacity", `${settings.customBackgroundOpacity / 100}`);
      } else {
        shell.style.removeProperty("--tikz-custom-bg");
        shell.style.removeProperty("--tikz-custom-bg-opacity");
      }
    };

    const applyZoom = (): void => {
      if (naturalWidth > 0 && naturalHeight > 0) {
        img.style.width = `${naturalWidth * zoom}px`;
        img.style.height = `${naturalHeight * zoom}px`;
        img.style.maxWidth = "none";
      }
      img.style.transform = `translate3d(${panX}px, ${panY}px, 0)`;
      img.dataset.zoom = `${Math.round(zoom * 100)}%`;
      viewport.classList.toggle("is-pannable", zoom > 1);
      viewport.classList.toggle("is-dragging", dragging);
      viewport.style.touchAction = zoom > 1 ? "none" : "pan-y";
      applyTheme();
      positionControls();
      positionPanel();
    };

    const closePanel = (): void => {
      panel.hidden = true;
      menu.setAttribute("aria-expanded", "false");
      menu.removeAttribute("data-open");
    };

    const openPanel = (): void => {
      if (controls.hidden || !shell.isConnected) return;
      panel.hidden = false;
      menu.setAttribute("aria-expanded", "true");
      menu.setAttribute("data-open", "true");
      positionPanel();
    };

    const resetView = (): void => {
      zoom = clampZoom(this.getSettings().defaultZoom / 100);
      panX = 0;
      panY = 0;
      applyZoom();
    };

    const fit = (): void => {
      if (!naturalWidth) return;
      const availableWidth = Math.max(1, this.host.clientWidth);
      zoom = clampZoom(Math.min(1, availableWidth / naturalWidth));
      panX = 0;
      panY = 0;
      applyZoom();
    };

    menu.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (panel.hidden) openPanel();
      else closePanel();
    });

    const outsidePointerDown = (event: PointerEvent): void => {
      if (panel.hidden) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (controls.contains(target) || panel.contains(target)) return;
      closePanel();
    };
    document.addEventListener("pointerdown", outsidePointerDown, true);

    const addButton = (label: string, action: () => void | Promise<void>): void => {
      const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitem" } });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void action();
      });
    };

    const buildMainPanel = (): void => {
      panel.empty();
      addButton("Zoom −", () => { zoom = clampZoom(zoom - 0.25); applyZoom(); });
      addButton("Zoom +", () => { zoom = clampZoom(zoom + 0.25); applyZoom(); });
      addButton("Reset view", resetView);
      addButton("Fit", fit);
      addButton("Theme", () => renderThemeMenu());
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
          positionPanel();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        }
      });
      addButton("Export PNG", async () => {
        try {
          const path = await this.exportService.savePng(this.result.svg, this.result.hash, this.sourcePath);
          this.showAssetLink(panel, "PNG", path);
          positionPanel();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        }
      });
    };

    const renderThemeMenu = (): void => {
      panel.empty();
      panel.createDiv({ cls: "tikz-renderer-panel-title", text: "Theme" });
      const themes: Array<[DisplayTheme, string]> = [["auto", "Auto"], ["obsidian", "Obsidian"], ["light", "Light"], ["paper", "Paper"], ["dark", "Dark"], ["contrast", "Contrast"], ["bw", "Black & white"], ["custom", "Custom"]];
      for (const [theme, label] of themes) {
        const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitemradio", "aria-checked": `${this.getSettings().displayTheme === theme}` } });
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await this.saveSettings({ ...this.getSettings(), displayTheme: theme });
          applyTheme();
          if (theme === "custom") renderThemeMenu();
          else closePanel();
        });
      }
      if (this.getSettings().displayTheme === "custom") {
        const color = panel.createEl("input", { attr: { type: "color", value: this.getSettings().customBackgroundColor, "aria-label": "Custom background color" } });
        color.addEventListener("change", async () => {
          await this.saveSettings({ ...this.getSettings(), customBackgroundColor: color.value });
          applyTheme();
        });
        const opacity = panel.createEl("input", { attr: { type: "range", min: "10", max: "100", step: "1", value: `${this.getSettings().customBackgroundOpacity}`, "aria-label": "Custom background opacity" } });
        opacity.addEventListener("input", () => shell.style.setProperty("--tikz-custom-bg-opacity", `${Number(opacity.value) / 100}`));
        opacity.addEventListener("change", async () => this.saveSettings({ ...this.getSettings(), customBackgroundOpacity: Number(opacity.value) }));
      }
      const back = panel.createEl("button", { text: "Back", attr: { type: "button" } });
      back.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        buildMainPanel();
        positionPanel();
      });
      positionPanel();
    };

    buildMainPanel();

    assetLink.addEventListener("click", (event) => {
      if (dragging) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (zoom <= 1 && this.result.assetPath) this.app.workspace.openLinkText(this.result.assetPath, this.sourcePath, false);
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
      panX += event.clientX - lastX;
      panY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      img.style.transform = `translate3d(${panX}px, ${panY}px, 0)`;
      event.preventDefault();
    });
    const stopDragging = (): void => {
      dragging = false;
      viewport.classList.remove("is-dragging");
    };
    viewport.addEventListener("pointerup", stopDragging);
    viewport.addEventListener("pointercancel", stopDragging);
    viewport.addEventListener("lostpointercapture", stopDragging);

    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!naturalWidth || !naturalHeight) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const oldZoom = zoom;
      const nextZoom = clampZoom(oldZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
      if (nextZoom === oldZoom) return;
      const rect = viewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const ratio = nextZoom / oldZoom;
      panX = pointerX - (pointerX - panX) * ratio;
      panY = pointerY - (pointerY - panY) * ratio;
      zoom = nextZoom;
      applyZoom();
    };
    viewport.addEventListener("wheel", wheel, { passive: false, capture: true });

    const initializeIntrinsicSize = (): void => {
      naturalWidth = img.naturalWidth;
      naturalHeight = img.naturalHeight;
      if (!naturalWidth || !naturalHeight) return;
      applyZoom();
    };
    img.addEventListener("load", initializeIntrinsicSize, { once: true });
    if (img.complete) initializeIntrinsicSize();

    const observer = new MutationObserver(() => {
      applyTheme();
      positionControls();
      positionPanel();
    });
    observer.observe(body, { attributes: true, attributeFilter: ["class"] });

    const resizeObserver = new ResizeObserver(() => {
      positionControls();
      positionPanel();
    });
    resizeObserver.observe(shell);

    const view = this.host.ownerDocument.defaultView;
    const reposition = (): void => {
      positionControls();
      positionPanel();
    };
    view?.addEventListener("scroll", reposition, true);
    view?.addEventListener("resize", reposition);

    applyTheme();
    positionControls();

    this.cleanup = () => {
      document.removeEventListener("pointerdown", outsidePointerDown, true);
      view?.removeEventListener("scroll", reposition, true);
      view?.removeEventListener("resize", reposition);
      observer.disconnect();
      resizeObserver.disconnect();
      controls.remove();
      panel.remove();
      if (TikzRendererView.activeViews.get(this.historyKey) === this) TikzRendererView.activeViews.delete(this.historyKey);
      TikzRendererView.allViews.delete(this);
      this.cleanup = undefined;
    };
  }

  dispose(): void { this.cleanup?.(); }

  static disposeAll(): void {
    for (const view of Array.from(TikzRendererView.allViews)) view.dispose();
    TikzRendererView.activeViews.clear();
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
    if (entries.length === 0) {
      panel.createDiv({ text: "No previous versions yet." });
      return;
    }
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

function clampZoom(value: number): number { return Math.min(5, Math.max(0.25, value)); }

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