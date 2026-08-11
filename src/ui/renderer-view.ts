import { App, MarkdownRenderChild, Modal, Notice } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { DisplayTheme, TikzSettings } from "../settings/settings";

export class TikzRendererView extends MarkdownRenderChild {
  private cleanup?: () => void;
  private static readonly activeViews = new Map<string, TikzRendererView>();
  private static readonly allViews = new Set<TikzRendererView>();

  constructor(
    private readonly app: App,
    private readonly exportService: ExportService,
    host: HTMLElement,
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
  ) { super(host); }

  render(): void {
    this.cleanup?.();
    const previous = TikzRendererView.activeViews.get(this.historyKey);
    if (previous && previous !== this) previous.dispose();
    TikzRendererView.activeViews.set(this.historyKey, this);
    TikzRendererView.allViews.add(this);
    this.containerEl.empty();

    const doc = this.containerEl.ownerDocument;
    const win = doc.defaultView;
    const shell = this.containerEl.createDiv({ cls: "tikz-renderer-shell" });
    const paper = shell.createDiv({ cls: "tikz-renderer-paper" });
    const viewport = paper.createDiv({ cls: "tikz-renderer-viewport" });

    const parsed = new DOMParser().parseFromString(this.result.svg, "image/svg+xml");
    if (parsed.querySelector("parsererror") || parsed.documentElement.tagName.toLowerCase() !== "svg") throw new Error("The TeX renderer produced invalid SVG output.");
    const svg = doc.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
    svg.classList.add("tikz-renderer-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "TikZ diagram");
    svg.setAttribute("draggable", "false");
    viewport.appendChild(svg);

    const controls = shell.createDiv({ cls: "tikz-renderer-controls" });
    const menu = controls.createEl("button", { cls: "tikz-renderer-menu", text: "⋯", attr: { type: "button", title: "TikZ controls", "aria-label": "TikZ controls", "aria-expanded": "false" } });
    const panel = shell.createDiv({ cls: "tikz-renderer-panel" });
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

    const closePanel = (): void => {
      panel.hidden = true;
      menu.setAttribute("aria-expanded", "false");
      menu.removeAttribute("data-open");
    };

    const positionPanel = (): void => {
      if (panel.hidden || !shell.isConnected) return;
      const button = menu.getBoundingClientRect();
      const viewportWidth = win?.innerWidth ?? doc.documentElement.clientWidth;
      const viewportHeight = win?.innerHeight ?? doc.documentElement.clientHeight;
      const panelWidth = Math.min(270, Math.max(230, viewportWidth - 16));
      panel.style.width = `${panelWidth}px`;
      const rect = panel.getBoundingClientRect();
      let left = button.right - rect.width;
      let top = button.bottom + 6;
      if (left < 8) left = 8;
      if (left + rect.width > viewportWidth - 8) left = Math.max(8, viewportWidth - rect.width - 8);
      if (top + rect.height > viewportHeight - 8) top = button.top - rect.height - 6;
      if (top < 8) top = 8;
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    };

    const positionControls = (): void => {
      if (!shell.isConnected) return;
      const rect = shell.getBoundingClientRect();
      const h = win?.innerHeight ?? doc.documentElement.clientHeight;
      const w = win?.innerWidth ?? doc.documentElement.clientWidth;
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < h && rect.right > 0 && rect.left < w;
      controls.hidden = !visible;
      if (!visible) closePanel();
      positionPanel();
    };

    const applyTheme = (): void => {
      const settings = this.getSettings();
      const theme = settings.displayTheme === "auto" ? detectTheme(doc) : settings.displayTheme;
      shell.dataset.theme = theme;
      if (theme === "custom") {
        shell.style.setProperty("--tikz-custom-bg", settings.customBackgroundColor);
        shell.style.setProperty("--tikz-custom-bg-opacity", `${settings.customBackgroundOpacity / 100}`);
      } else {
        shell.style.removeProperty("--tikz-custom-bg");
        shell.style.removeProperty("--tikz-custom-bg-opacity");
      }
    };

    const ensureIntrinsicSize = (): boolean => {
      if (naturalWidth > 0 && naturalHeight > 0) return true;
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { naturalWidth = rect.width; naturalHeight = rect.height; return true; }
      const box = svg.viewBox?.baseVal;
      if (box && box.width > 0 && box.height > 0) { naturalWidth = box.width; naturalHeight = box.height; return true; }
      const width = Number.parseFloat(svg.getAttribute("width") ?? "");
      const height = Number.parseFloat(svg.getAttribute("height") ?? "");
      if (width > 0 && height > 0) { naturalWidth = width; naturalHeight = height; return true; }
      return false;
    };

    const applyZoom = (): void => {
      ensureIntrinsicSize();
      if (naturalWidth > 0 && naturalHeight > 0) {
        svg.style.width = `${naturalWidth * zoom}px`;
        svg.style.height = `${naturalHeight * zoom}px`;
        svg.style.maxWidth = "none";
      }
      svg.style.transform = `translate3d(${panX}px, ${panY}px, 0)`;
      svg.dataset.zoom = `${Math.round(zoom * 100)}%`;
      viewport.classList.toggle("is-pannable", zoom > 1);
      viewport.classList.toggle("is-dragging", dragging);
      viewport.style.touchAction = zoom > 1 ? "none" : "pan-y";
      applyTheme();
      positionControls();
      positionPanel();
    };

    const resetView = (): void => { zoom = clampZoom(this.getSettings().defaultZoom / 100); panX = 0; panY = 0; applyZoom(); };
    const fit = (): void => {
      if (!ensureIntrinsicSize()) return;
      zoom = clampZoom(Math.min(1, Math.max(1, this.containerEl.clientWidth) / naturalWidth));
      panX = 0; panY = 0; applyZoom();
    };

    const addButton = (label: string, action: () => void | Promise<void>): void => {
      const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitem" } });
      button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void action(); });
    };

    const showAssetActions = (): void => {
      const path = this.result.assetPath;
      if (!path) return;
      const links = panel.createDiv({ cls: "tikz-renderer-asset-links" });
      links.createEl("a", { text: `SVG: ${path}`, attr: { href: "#" } }).addEventListener("click", (event) => { event.preventDefault(); this.app.workspace.openLinkText(path, this.sourcePath, false); });
      links.createEl("button", { text: "Copy SVG wikilink", attr: { type: "button" } }).addEventListener("click", async (event) => { event.preventDefault(); event.stopPropagation(); await navigator.clipboard.writeText(`[[${path}]]`); new Notice("SVG wikilink copied."); });
      links.createEl("button", { text: "Copy SVG embed", attr: { type: "button" } }).addEventListener("click", async (event) => { event.preventDefault(); event.stopPropagation(); await navigator.clipboard.writeText(`![[${path}]]`); new Notice("SVG embed copied."); });
    };

    const renderThemeMenu = (): void => {
      panel.empty();
      panel.createDiv({ cls: "tikz-renderer-panel-title", text: "Theme" });
      const themes: Array<[DisplayTheme, string]> = [["auto", "Auto"], ["obsidian", "Obsidian"], ["light", "Light"], ["paper", "Paper"], ["dark", "Dark"], ["contrast", "Contrast"], ["bw", "Black & white"], ["custom", "Custom"]];
      for (const [theme, label] of themes) {
        const button = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitemradio", "aria-checked": `${this.getSettings().displayTheme === theme}` } });
        button.addEventListener("click", async (event) => { event.preventDefault(); event.stopPropagation(); await this.saveSettings({ ...this.getSettings(), displayTheme: theme }); applyTheme(); if (theme === "custom") renderThemeMenu(); else closePanel(); });
      }
      if (this.getSettings().displayTheme === "custom") {
        const color = panel.createEl("input", { attr: { type: "color", value: this.getSettings().customBackgroundColor, "aria-label": "Custom background color" } });
        color.addEventListener("change", async () => { await this.saveSettings({ ...this.getSettings(), customBackgroundColor: color.value }); applyTheme(); });
        const opacity = panel.createEl("input", { attr: { type: "range", min: "10", max: "100", step: "1", value: `${this.getSettings().customBackgroundOpacity}`, "aria-label": "Custom background opacity" } });
        opacity.addEventListener("input", () => shell.style.setProperty("--tikz-custom-bg-opacity", `${Number(opacity.value) / 100}`));
        opacity.addEventListener("change", async () => this.saveSettings({ ...this.getSettings(), customBackgroundOpacity: Number(opacity.value) }));
      }
      panel.createEl("button", { text: "Back", attr: { type: "button" } }).addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); buildMainPanel(); positionPanel(); });
      positionPanel();
    };

    const showHistory = (): void => {
      panel.empty();
      panel.createDiv({ cls: "tikz-renderer-panel-title", text: "History" });
      const entries = this.history.list(this.historyKey);
      if (!entries.length) panel.createDiv({ text: "No previous versions yet." });
      for (const [index, entry] of entries.entries()) {
        const row = panel.createDiv({ cls: "tikz-history-row" });
        row.createSpan({ text: `Version ${entries.length - index}` });
        row.createSpan({ text: new Date(entry.timestamp).toLocaleString() });
        if (entry.source !== this.source) row.createEl("button", { text: "Restore", attr: { type: "button" } }).addEventListener("click", () => new TikzSourceModal(this.app, entry.source, async (next) => this.editSource(next)).open());
      }
      panel.createEl("button", { text: "Back", attr: { type: "button" } }).addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); buildMainPanel(); positionPanel(); });
      positionPanel();
    };

    const buildMainPanel = (): void => {
      panel.empty();
      panel.createDiv({ cls: "tikz-renderer-panel-title", text: "TikZ controls" });
      addButton("Zoom −", () => { zoom = clampZoom(zoom - 0.25); applyZoom(); });
      addButton("Zoom +", () => { zoom = clampZoom(zoom + 0.25); applyZoom(); });
      addButton("Reset view", resetView);
      addButton("Fit", fit);
      addButton("Theme", renderThemeMenu);
      addButton("Edit source", () => new TikzSourceModal(this.app, this.source, async (next) => this.editSource(next)).open());
      addButton("History", showHistory);
      addButton("Re-render", async () => {
        try {
          const next = await this.service.render(this.source, this.kind);
          this.result.svg = next.svg; this.result.hash = next.hash; this.result.engine = next.engine; this.result.fromCache = next.fromCache;
          this.result.assetPath = await this.exportService.saveSvg(next.svg, next.hash, this.sourcePath, false);
          closePanel(); this.render();
        } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
      });
      addButton("Copy source", async () => { await navigator.clipboard.writeText(this.source); new Notice("TikZ source copied."); });
      addButton("Copy embed", async () => { await navigator.clipboard.writeText(`\`\`\`${this.kind}\n${this.source}\n\`\`\``); new Notice("TikZ embed copied."); });
      addButton("Export SVG", async () => { try { this.result.assetPath = await this.exportService.saveSvg(this.result.svg, this.result.hash, this.sourcePath); showAssetActions(); positionPanel(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } });
      addButton("Export PNG", async () => { try { const path = await this.exportService.savePng(this.result.svg, this.result.hash, this.sourcePath); const links = panel.createDiv({ cls: "tikz-renderer-asset-links" }); links.createEl("a", { text: `PNG: ${path}`, attr: { href: "#" } }).addEventListener("click", (event) => { event.preventDefault(); this.app.workspace.openLinkText(path, this.sourcePath, false); }); positionPanel(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } });
      if (this.result.assetPath) showAssetActions();
    };

    const openPanel = (): void => {
      if (!shell.isConnected || controls.hidden) return;
      panel.hidden = false;
      menu.setAttribute("aria-expanded", "true");
      menu.setAttribute("data-open", "true");
      buildMainPanel();
      positionPanel();
    };

    menu.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); if (panel.hidden) openPanel(); else closePanel(); });
    const outsidePointerDown = (event: PointerEvent): void => { if (!panel.hidden && (!(event.target instanceof Node) || !shell.contains(event.target))) closePanel(); };
    doc.addEventListener("pointerdown", outsidePointerDown, true);
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape" && !panel.hidden) { closePanel(); menu.focus(); } };
    doc.addEventListener("keydown", escape, true);

    svg.addEventListener("click", (event) => { if (dragging) { event.preventDefault(); return; } event.preventDefault(); event.stopPropagation(); if (zoom <= 1 && this.result.assetPath) this.app.workspace.openLinkText(this.result.assetPath, this.sourcePath, false); });
    viewport.addEventListener("pointerdown", (event) => { if (event.button !== 0 || zoom <= 1) return; dragging = true; lastX = event.clientX; lastY = event.clientY; viewport.setPointerCapture(event.pointerId); viewport.classList.add("is-dragging"); event.preventDefault(); });
    viewport.addEventListener("pointermove", (event) => { if (!dragging) return; panX += event.clientX - lastX; panY += event.clientY - lastY; lastX = event.clientX; lastY = event.clientY; svg.style.transform = `translate3d(${panX}px, ${panY}px, 0)`; event.preventDefault(); });
    const stopDragging = (): void => { dragging = false; viewport.classList.remove("is-dragging"); };
    viewport.addEventListener("pointerup", stopDragging); viewport.addEventListener("pointercancel", stopDragging); viewport.addEventListener("lostpointercapture", stopDragging);

    const wheel = (event: WheelEvent): void => {
      if ((!event.ctrlKey && !event.metaKey) || !shell.isConnected) return;
      const target = event.target;
      if (!(target instanceof Node) || !viewport.contains(target)) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      if (!ensureIntrinsicSize()) return;
      event.preventDefault();
      event.stopPropagation();
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
    win?.addEventListener("wheel", wheel, { passive: false, capture: true });

    const observer = new MutationObserver(() => { applyTheme(); positionControls(); positionPanel(); });
    observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
    const resizeObserver = new ResizeObserver(() => { positionControls(); positionPanel(); });
    resizeObserver.observe(shell);
    const reposition = (): void => { positionControls(); positionPanel(); };
    win?.addEventListener("scroll", reposition, true); win?.addEventListener("resize", reposition);

    buildMainPanel();
    closePanel();
    applyTheme();
    positionControls();
    ensureIntrinsicSize();
    applyZoom();

    this.cleanup = () => {
      doc.removeEventListener("pointerdown", outsidePointerDown, true);
      doc.removeEventListener("keydown", escape, true);
      win?.removeEventListener("wheel", wheel, true);
      win?.removeEventListener("scroll", reposition, true);
      win?.removeEventListener("resize", reposition);
      observer.disconnect(); resizeObserver.disconnect(); closePanel();
      if (TikzRendererView.activeViews.get(this.historyKey) === this) TikzRendererView.activeViews.delete(this.historyKey);
      TikzRendererView.allViews.delete(this); this.cleanup = undefined;
    };
  }

  onunload(): void { this.cleanup?.(); this.containerEl.empty(); }
  dispose(): void { this.unload(); }
  static disposeAll(): void { for (const view of Array.from(this.allViews)) view.unload(); this.activeViews.clear(); this.allViews.clear(); }
}

function detectTheme(doc: Document): string { if (doc.body.classList.contains("theme-dark")) return "dark"; if (doc.body.classList.contains("theme-light")) return "light"; return "obsidian"; }
function clampZoom(value: number): number { return Math.min(5, Math.max(0.25, value)); }

class TikzSourceModal extends Modal {
  constructor(app: App, private readonly initialSource: string, private readonly onRender: (source: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.empty(); this.contentEl.empty();
    const editor = this.contentEl.createEl("textarea", { cls: "tikz-source-editor" }); editor.value = this.initialSource; editor.spellcheck = false;
    const actions = this.contentEl.createDiv({ cls: "tikz-source-actions" });
    actions.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "Render", attr: { type: "button" } }).addEventListener("click", async () => { try { await this.onRender(editor.value); this.close(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } });
    editor.focus();
  }
}
