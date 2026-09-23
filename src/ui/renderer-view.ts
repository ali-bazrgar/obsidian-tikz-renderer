import { App, MarkdownRenderChild, MarkdownView, Modal, Notice } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { DisplayTheme, TikzSettings } from "../settings/settings";

type TikzViewState = { zoom: number; panX: number; panY: number; viewportHeight: number };
type TikzThemeState = { displayTheme: DisplayTheme; customBackgroundColor: string; customBackgroundOpacity: number };

export class TikzRendererView extends MarkdownRenderChild {
  private cleanup?: () => void;
  private sharedStateKey?: string;
  private applyExternalState?: (state: TikzViewState) => void;
  private static readonly activeViews = new Map<string, TikzRendererView>();
  private static readonly allViews = new Set<TikzRendererView>();
  private static readonly viewStates = new Map<string, TikzViewState>();
  private static readonly themeStates = new Map<string, TikzThemeState>();

  constructor(private readonly app: App, private readonly exportService: ExportService, host: HTMLElement, private readonly result: RenderResult, private readonly source: string, private readonly sourcePath: string, private readonly service: RenderService, private readonly kind: RenderResult["kind"], private readonly history: TikzHistoryStore, private readonly historyKey: string, private readonly editSource: (source: string) => Promise<void>, private readonly getSettings: () => TikzSettings, private readonly saveSettings: (settings: TikzSettings) => Promise<void>) { super(host); }

  render(): void {
    this.cleanup?.();
    const stateKey = `${this.sourcePath}::${this.historyKey}`;
    this.sharedStateKey = stateKey;
    const previous = TikzRendererView.activeViews.get(stateKey);
    if (previous && previous !== this) previous.dispose(false);
    TikzRendererView.activeViews.set(stateKey, this);
    TikzRendererView.allViews.add(this);
    this.containerEl.empty();
    const doc = this.containerEl.ownerDocument; const win = doc.defaultView;
    const shell = this.containerEl.createDiv({ cls: "tikz-renderer-shell" });
    const viewport = shell.createDiv({ cls: "tikz-renderer-viewport" });
    const parsed = new DOMParser().parseFromString(this.result.svg, "image/svg+xml");
    if (parsed.querySelector("parsererror") || parsed.documentElement.tagName.toLowerCase() !== "svg") throw new Error("The TeX renderer produced invalid SVG output.");
    const svg = doc.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
    svg.classList.add("tikz-renderer-svg"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "TikZ diagram"); svg.setAttribute("draggable", "false"); viewport.appendChild(svg);

    const controls = shell.createDiv({ cls: "tikz-renderer-controls" });
    const menu = controls.createEl("button", { cls: "tikz-renderer-menu", text: "⋯", attr: { type: "button", title: "TikZ controls", "aria-label": "TikZ controls", "aria-expanded": "false" } });
    const panel = doc.body.createDiv({ cls: "tikz-renderer-panel" }); panel.hidden = true; panel.setAttribute("role", "menu"); panel.dataset.tikzPopup = "true";
    const existingState = TikzRendererView.viewStates.get(stateKey);
    const persisted = existingState ?? loadViewState(stateKey);
    if (persisted && !existingState) TikzRendererView.viewStates.set(stateKey, persisted);
    const settings = this.getSettings();
    const persistedTheme = TikzRendererView.themeStates.get(stateKey) ?? loadThemeState(stateKey);
    const themeState: TikzThemeState = persistedTheme ?? { displayTheme: settings.displayTheme, customBackgroundColor: settings.customBackgroundColor, customBackgroundOpacity: settings.customBackgroundOpacity };
    TikzRendererView.themeStates.set(stateKey, themeState);
    const initialEditState: TikzViewState = persisted ?? { zoom: clampZoom(settings.defaultZoom / 100), panX: 0, panY: 0, viewportHeight: 0 };
    TikzRendererView.viewStates.set(stateKey, initialEditState);
    let zoom = initialEditState.zoom, panX = initialEditState.panX, panY = initialEditState.panY, naturalWidth = 0, naturalHeight = 0, viewportHeight = initialEditState.viewportHeight, dragging = false, lastX = 0, lastY = 0;
    let readingMode = false;
    const getCurrentMode = (): "reading" | "writing" => {
      // Prefer Obsidian's own MarkdownView mode. This remains authoritative
      // while switching between Reading View and Write/Live Preview, even when
      // the DOM is temporarily being rebuilt.
      const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (markdownView?.getMode() === "preview") return "reading";
      if (markdownView?.getMode() === "source") return "writing";

      // Fallback for embedded/non-active rendering contexts where there is no
      // active MarkdownView available.
      return shell.closest(".markdown-preview-view") ? "reading" : "writing";
    };
    const isReadingMode = (): boolean => getCurrentMode() === "reading";
    const closePanel = (): void => { panel.hidden = true; menu.setAttribute("aria-expanded", "false"); menu.removeAttribute("data-open"); };

    const getViewportWidth = (): number => Math.max(1, Math.round(shell.clientWidth || this.containerEl.clientWidth || viewport.getBoundingClientRect().width || naturalWidth));
    const getViewportHeight = (): number => Math.max(1, Math.round(viewport.clientHeight || viewportHeight || naturalHeight * zoom || 1));
    const syncViewportGeometry = (): void => {
      viewport.style.width = `${getViewportWidth()}px`;
      viewport.style.maxWidth = "100%";
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) viewportHeight = clampViewportHeight(naturalHeight * zoom);
      viewportHeight = clampViewportHeight(viewportHeight);
      viewport.style.height = `${viewportHeight}px`;
    };
    const clampCurrentPan = (): void => {
      // Keep pan coordinates finite, but intentionally do not clamp them to
      // the viewport edges. The figure behaves like an unbounded canvas:
      // users can drag it freely in any direction and return to it later.
      syncViewportGeometry();
      panX = Number.isFinite(panX) ? panX : 0;
      panY = Number.isFinite(panY) ? panY : 0;
    };
    const getContentAlignmentOffset = (): { x: number; y: number } => {
      const width = getViewportWidth();
      const height = getViewportHeight();
      const contentWidth = Math.max(1, naturalWidth * zoom);
      const contentHeight = Math.max(1, naturalHeight * zoom);
      return {
        x: contentWidth < width ? Math.max(0, (width - contentWidth) / 2) : 0,
        y: contentHeight < height ? Math.max(0, (height - contentHeight) / 2) : 0,
      };
    };
    const applySvgTransform = (): void => {
      const offset = getContentAlignmentOffset();
      svg.style.transform = `translate3d(${offset.x + panX}px, ${offset.y + panY}px, 0)`;
    };
    const applyLocalViewState = (state: TikzViewState): void => {
      zoom = clampZoom(state.zoom); panX = Number.isFinite(state.panX) ? state.panX : 0; panY = Number.isFinite(state.panY) ? state.panY : 0;
      if (Number.isFinite(state.viewportHeight) && state.viewportHeight > 0) viewportHeight = clampViewportHeight(state.viewportHeight);
      if (naturalWidth > 0 && naturalHeight > 0) { svg.style.width = `${naturalWidth * zoom}px`; svg.style.height = `${naturalHeight * zoom}px`; svg.style.maxWidth = "none"; }
      syncViewportGeometry(); clampCurrentPan(); applySvgTransform();
      viewport.classList.toggle("is-pannable", !isReadingMode() && zoom > 1); viewport.style.touchAction = "none";
    };
    const syncSharedState = (): boolean => { const shared = TikzRendererView.viewStates.get(stateKey); if (!shared) return false; const changed = zoom !== shared.zoom || panX !== shared.panX || panY !== shared.panY || viewportHeight !== shared.viewportHeight; if (changed) applyLocalViewState(shared); return changed; };
    const updateMode = (): boolean => {
      const nextReadingMode = isReadingMode();
      const changedMode = nextReadingMode !== readingMode;
      if (changedMode || nextReadingMode) {
        // Write is the authoritative interactive mode. Read is a passive
        // presentation of the exact state currently owned by Write.
        const shared = TikzRendererView.viewStates.get(stateKey) ?? loadViewState(stateKey) ?? initialEditState;
        applyLocalViewState(shared);
        dragging = false;
      }
      readingMode = nextReadingMode;
      shell.dataset.mode = nextReadingMode ? "reading" : "writing";
      controls.hidden = nextReadingMode;
      if (nextReadingMode) closePanel();
      return changedMode;
    };
    const persistViewState = (): void => {
      if (isReadingMode()) return;
      clampCurrentPan();
      const state = { zoom, panX, panY, viewportHeight: clampViewportHeight(viewportHeight) };
      TikzRendererView.viewStates.set(stateKey, state);
      saveViewState(stateKey, state);
      for (const view of TikzRendererView.allViews) {
        if (view !== this && view.sharedStateKey === stateKey) view.applyExternalState?.(state);
      }
    };
    const positionPanel = (): void => { if (panel.hidden || !shell.isConnected || isReadingMode()) return; const b = menu.getBoundingClientRect(); const vw = win?.innerWidth ?? doc.documentElement.clientWidth; const vh = win?.innerHeight ?? doc.documentElement.clientHeight; const width = Math.min(270, Math.max(230, vw - 16)); panel.style.width = `${width}px`; const r = panel.getBoundingClientRect(); let left = b.left; let top = b.bottom + 6; if (left + r.width > vw - 8) left = Math.max(8, vw - r.width - 8); if (left < 8) left = 8; if (top + r.height > vh - 8) top = b.top - r.height - 6; if (top < 8) top = 8; panel.style.left = `${Math.round(left)}px`; panel.style.top = `${Math.round(top)}px`; };
    const applyTheme = (): void => { const theme = themeState.displayTheme === "auto" ? detectTheme(doc) : themeState.displayTheme; shell.dataset.theme = theme; if (theme === "custom") { shell.style.setProperty("--tikz-custom-bg", themeState.customBackgroundColor); shell.style.setProperty("--tikz-custom-bg-opacity", `${themeState.customBackgroundOpacity / 100}`); } else { shell.style.removeProperty("--tikz-custom-bg"); shell.style.removeProperty("--tikz-custom-bg-opacity"); } };
    const persistTheme = (): void => { TikzRendererView.themeStates.set(stateKey, { ...themeState }); saveThemeState(stateKey, themeState); applyTheme(); };
    const ensureIntrinsicSize = (): boolean => { if (naturalWidth > 0 && naturalHeight > 0) return true; const b = svg.viewBox?.baseVal; if (b && b.width > 0 && b.height > 0) { naturalWidth = b.width; naturalHeight = b.height; return true; } const w = Number.parseFloat(svg.getAttribute("width") ?? ""); const h = Number.parseFloat(svg.getAttribute("height") ?? ""); if (w > 0 && h > 0) { naturalWidth = w; naturalHeight = h; return true; } return false; };
    const ensureViewportSize = (): void => { if (!ensureIntrinsicSize()) return; if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) viewportHeight = clampViewportHeight(naturalHeight * zoom); syncViewportGeometry(); clampCurrentPan(); };
    const applyZoom = (): void => { ensureViewportSize(); if (naturalWidth > 0 && naturalHeight > 0) { svg.style.width = `${naturalWidth * zoom}px`; svg.style.height = `${naturalHeight * zoom}px`; svg.style.maxWidth = "none"; } syncViewportGeometry(); clampCurrentPan(); applySvgTransform(); viewport.classList.toggle("is-pannable", !isReadingMode() && zoom > 1); viewport.classList.toggle("is-dragging", dragging); viewport.style.touchAction = "none"; applyTheme(); updateMode(); positionPanel(); };
    const resetView = (): void => { if (isReadingMode()) return; zoom = clampZoom(settings.defaultZoom / 100); panX = 0; panY = 0; viewportHeight = clampViewportHeight(naturalHeight * zoom); persistViewState(); applyZoom(); };
    const fit = (): void => { if (isReadingMode() || !ensureIntrinsicSize()) return; const width = getViewportWidth(); zoom = clampZoom(Math.min(1, width / naturalWidth)); panX = 0; panY = 0; viewportHeight = clampViewportHeight(naturalHeight * zoom); persistViewState(); applyZoom(); };
    const addButton = (label: string, action: () => void | Promise<void>): void => { const b = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitem" } }); b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); void action(); }); };
    const exportPng = async (): Promise<void> => {
      if (isReadingMode()) return;
      ensureViewportSize();
      clampCurrentPan();
      const width = getViewportWidth();
      const height = getViewportHeight();
      const backgroundColor = win?.getComputedStyle(viewport).backgroundColor ?? "transparent";
      const renderedSvg = createRenderedSvgSnapshot(svg, win);
      await this.exportService.savePngSnapshot(renderedSvg, this.result.hash, this.sourcePath, width, height, zoom, panX, panY, backgroundColor);
    };
    const showAssetActions = (): void => { const path = this.result.assetPath; if (!path) return; const links = panel.createDiv({ cls: "tikz-renderer-asset-links" }); links.createEl("a", { text: `SVG: ${path}`, attr: { href: "#" } }).addEventListener("click", e => { e.preventDefault(); this.app.workspace.openLinkText(path, this.sourcePath, false); }); links.createEl("button", { text: "Copy SVG wikilink", attr: { type: "button" } }).addEventListener("click", async e => { e.preventDefault(); e.stopPropagation(); await navigator.clipboard.writeText(`[[${path}]]`); new Notice("SVG wikilink copied."); }); };
    const renderThemeMenu = (): void => { panel.empty(); panel.createDiv({ cls: "tikz-renderer-panel-title", text: "Theme" }); const themes: Array<[DisplayTheme, string]> = [["auto", "Auto"], ["obsidian", "Obsidian"], ["light", "Light"], ["paper", "Paper"], ["dark", "Dark"], ["contrast", "Contrast"], ["bw", "Black & white"], ["custom", "Custom"]]; for (const [theme, label] of themes) { const b = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitemradio", "aria-checked": `${themeState.displayTheme === theme}` } }); b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); themeState.displayTheme = theme; persistTheme(); if (theme === "custom") renderThemeMenu(); else closePanel(); }); } if (themeState.displayTheme === "custom") { const color = panel.createEl("input", { attr: { type: "color", value: themeState.customBackgroundColor } }); color.addEventListener("change", () => { themeState.customBackgroundColor = color.value; persistTheme(); }); const opacity = panel.createEl("input", { attr: { type: "range", min: "10", max: "100", value: `${themeState.customBackgroundOpacity}` } }); opacity.addEventListener("input", () => { themeState.customBackgroundOpacity = Number(opacity.value); applyTheme(); }); opacity.addEventListener("change", () => persistTheme()); } panel.createEl("button", { text: "Back", attr: { type: "button" } }).addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); buildMainPanel(); }); positionPanel(); };
    const buildMainPanel = (): void => { panel.empty(); panel.createDiv({ cls: "tikz-renderer-panel-title", text: "TikZ controls" }); addButton("Zoom −", () => { if (isReadingMode()) return; const oldZoom = zoom; const nextZoom = clampZoom(oldZoom - .25); if (nextZoom !== oldZoom) zoom = nextZoom; persistViewState(); applyZoom(); }); addButton("Zoom +", () => { if (isReadingMode()) return; const oldZoom = zoom; const nextZoom = clampZoom(oldZoom + .25); if (nextZoom !== oldZoom) zoom = nextZoom; persistViewState(); applyZoom(); }); addButton("Reset view", resetView); addButton("Fit", fit); addButton("Theme", renderThemeMenu); addButton("Export PNG", exportPng); addButton("Edit source", () => new TikzSourceModal(this.app, this.source, async next => this.editSource(next)).open()); addButton("History", () => { panel.empty(); panel.createDiv({ cls: "tikz-renderer-panel-title", text: "History" }); const entries = this.history.list(this.historyKey); for (const [i, entry] of entries.entries()) { const row = panel.createDiv({ cls: "tikz-history-row" }); row.createSpan({ text: `Version ${entries.length - i}` }); row.createSpan({ text: new Date(entry.timestamp).toLocaleString() }); if (entry.source !== this.source) row.createEl("button", { text: "Restore", attr: { type: "button" } }).addEventListener("click", () => new TikzSourceModal(this.app, entry.source, async next => this.editSource(next)).open()); } panel.createEl("button", { text: "Back", attr: { type: "button" } }).addEventListener("click", () => buildMainPanel()); }); addButton("Re-render", async () => { const next = await this.service.render(this.source, this.kind, this.sourcePath); this.result.svg = next.svg; this.result.hash = next.hash; this.result.engine = next.engine; this.result.fromCache = next.fromCache; this.result.assetPath = await this.exportService.saveSvg(next.svg, next.hash, this.sourcePath, false); closePanel(); this.render(); }); addButton("Copy source", async () => { await navigator.clipboard.writeText(this.source); new Notice("TikZ source copied."); }); if (this.result.assetPath) showAssetActions(); };
    const openPanel = (): void => { if (!shell.isConnected || controls.hidden || isReadingMode()) return; panel.hidden = false; menu.setAttribute("aria-expanded", "true"); menu.setAttribute("data-open", "true"); buildMainPanel(); positionPanel(); };
    const togglePanel = (e: Event): void => { e.preventDefault(); e.stopPropagation(); if (isReadingMode()) return; if (panel.hidden) openPanel(); else closePanel(); };
    menu.addEventListener("pointerdown", togglePanel); menu.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && !isReadingMode()) togglePanel(e); });
    const outsidePointerDown = (e: PointerEvent): void => { if (!panel.hidden && (!(e.target instanceof Node) || (!shell.contains(e.target) && !panel.contains(e.target)))) closePanel(); }; doc.addEventListener("pointerdown", outsidePointerDown, true);
    const escape = (e: KeyboardEvent): void => { if (e.key === "Escape" && !panel.hidden) { closePanel(); menu.focus(); } }; doc.addEventListener("keydown", escape, true);
    svg.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); });
    viewport.addEventListener("pointerdown", e => {
      updateMode();
      if (readingMode || e.button !== 0 || zoom <= 1) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY; viewport.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    viewport.addEventListener("pointermove", e => { if (!dragging) return; panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; clampCurrentPan(); applySvgTransform(); e.preventDefault(); e.stopPropagation(); });
    const stopDragging = (): void => { if (!dragging) return; dragging = false; clampCurrentPan(); persistViewState(); viewport.classList.remove("is-dragging"); };
    viewport.addEventListener("pointerup", stopDragging); viewport.addEventListener("pointercancel", stopDragging); viewport.addEventListener("lostpointercapture", stopDragging);
    const wheel = (e: WheelEvent): void => {
      if (!shell.isConnected) return;
      updateMode();
      if (readingMode) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const target = e.target;
      if (!(target instanceof Node) || (!viewport.contains(target) && !path.includes(viewport))) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      if (!ensureIntrinsicSize()) return;

      e.preventDefault();
      e.stopPropagation();

      // Plain mouse wheel controls zoom. Ctrl+wheel controls viewport height.
      // Reading View and Live Preview intentionally use the same persistent view state.
      if (e.ctrlKey) {
        const delta = Number.isFinite(e.deltaY) ? e.deltaY : 0;
        if (delta === 0) return;
        const step = Math.max(10, Math.min(100, Math.abs(delta) * 0.5));
        viewportHeight = clampViewportHeight(viewportHeight + (delta < 0 ? step : -step));
        clampCurrentPan();
        persistViewState();
        applyZoom();
        return;
      }

      const old = zoom;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = clampZoom(old * factor);
      const r = viewport.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const oldOffset = getContentAlignmentOffset();
      const ratio = next / old;
      if (next !== old) {
        zoom = next;
        const newOffset = getContentAlignmentOffset();
        panX = x - newOffset.x - (x - oldOffset.x - panX) * ratio;
        panY = y - newOffset.y - (y - oldOffset.y - panY) * ratio;
        clampCurrentPan();
      }
      persistViewState();
      applyZoom();
    };
    // Listen on the stable window object in capture phase. Obsidian can
    // rebuild/reparent the editor DOM during Read/Write transitions, but the
    // window remains the same and receives the wheel event before CodeMirror.
    const windowWheel = (e: WheelEvent): void => {
      if (!shell.isConnected || isReadingMode()) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const target = e.target;
      if (!(target instanceof Node) || (!viewport.contains(target) && !path.includes(viewport))) return;
      wheel(e);
    };
    win?.addEventListener("wheel", windowWheel, { passive: false, capture: true });
    const observer = new MutationObserver(() => { const changed = updateMode(); if (changed) applyZoom(); else { applyTheme(); positionPanel(); } }); observer.observe(doc.body, { attributes: true, attributeFilter: ["class"], subtree: true });
    const resizeObserver = new ResizeObserver(() => {
      ensureViewportSize();
      positionPanel();
    });
    resizeObserver.observe(viewport);
    const reposition = (): void => positionPanel(); win?.addEventListener("scroll", reposition, true); win?.addEventListener("resize", reposition);
    buildMainPanel(); closePanel(); updateMode(); applyTheme(); ensureIntrinsicSize(); ensureViewportSize(); applyZoom();
    this.applyExternalState = (state: TikzViewState): void => { if (!isReadingMode()) applyLocalViewState(state); };
    this.cleanup = () => { if (TikzRendererView.activeViews.get(stateKey) === this) TikzRendererView.activeViews.delete(stateKey); doc.removeEventListener("pointerdown", outsidePointerDown, true); doc.removeEventListener("keydown", escape, true); menu.removeEventListener("pointerdown", togglePanel); win?.removeEventListener("wheel", windowWheel, true); win?.removeEventListener("scroll", reposition, true); win?.removeEventListener("resize", reposition); observer.disconnect(); resizeObserver.disconnect(); closePanel(); panel.remove(); TikzRendererView.allViews.delete(this); this.applyExternalState = undefined; this.cleanup = undefined; };
  }
  onunload(): void { this.cleanup?.(); this.containerEl.empty(); }
  dispose(emptyContainer = true): void { this.cleanup?.(); if (emptyContainer && this.containerEl.isConnected) this.containerEl.empty(); }
  static disposeAll(): void { for (const view of Array.from(this.allViews)) view.dispose(true); this.activeViews.clear(); this.allViews.clear(); }
}

function createRenderedSvgSnapshot(svg: SVGSVGElement, win: Window | null): string {
  const snapshot = svg.cloneNode(true) as SVGSVGElement;
  const sourceElements = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
  const snapshotElements = [snapshot, ...Array.from(snapshot.querySelectorAll<SVGElement>("*"))];
  const properties = [
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
    "color", "opacity", "filter", "font-family", "font-size", "font-style", "font-weight", "text-anchor", "dominant-baseline", "display", "visibility", "shape-rendering", "paint-order"
  ];
  if (win) {
    const count = Math.min(sourceElements.length, snapshotElements.length);
    for (let i = 0; i < count; i++) {
      const sourceElement = sourceElements[i];
      const snapshotElement = snapshotElements[i];
      const computed = win.getComputedStyle(sourceElement);
      for (const property of properties) {
        const value = computed.getPropertyValue(property);
        if (value) snapshotElement.style.setProperty(property, value);
      }
    }
  }
  snapshot.removeAttribute("class");
  snapshot.removeAttribute("role");
  snapshot.removeAttribute("aria-label");
  snapshot.removeAttribute("draggable");
  snapshot.style.transform = "none";
  snapshot.style.maxWidth = "none";
  return new XMLSerializer().serializeToString(snapshot);
}

function detectTheme(doc: Document): string { if (doc.body.classList.contains("theme-dark")) return "dark"; if (doc.body.classList.contains("theme-light")) return "light"; return "obsidian"; }
function clampZoom(value: number): number { return Math.min(5, Math.max(.25, value)); }
function clampViewportHeight(value: number): number { return Math.min(1600, Math.max(80, value)); }
function clampNumber(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function viewStorageKey(key: string): string { return `obsidian-tikz-renderer:view:${key}`; }
function themeStorageKey(key: string): string { return `obsidian-tikz-renderer:theme:${key}`; }
function loadViewState(key: string): TikzViewState | undefined { try { const raw = window.localStorage.getItem(viewStorageKey(key)); if (!raw) return undefined; const p = JSON.parse(raw) as Partial<TikzViewState>; if (!Number.isFinite(p.zoom) || !Number.isFinite(p.panX) || !Number.isFinite(p.panY)) return undefined; return { zoom: clampZoom(Number(p.zoom)), panX: Number(p.panX), panY: Number(p.panY), viewportHeight: Number.isFinite(p.viewportHeight) ? clampViewportHeight(Number(p.viewportHeight)) : 0 }; } catch { return undefined; } }
function saveViewState(key: string, state: TikzViewState): void { try { window.localStorage.setItem(viewStorageKey(key), JSON.stringify(state)); } catch { /* storage may be unavailable */ } }
function loadThemeState(key: string): TikzThemeState | undefined { try { const raw = window.localStorage.getItem(themeStorageKey(key)); if (!raw) return undefined; const p = JSON.parse(raw) as Partial<TikzThemeState>; if (typeof p.displayTheme !== "string" || typeof p.customBackgroundColor !== "string" || !Number.isFinite(p.customBackgroundOpacity)) return undefined; return { displayTheme: p.displayTheme as DisplayTheme, customBackgroundColor: p.customBackgroundColor, customBackgroundOpacity: Math.min(100, Math.max(10, Number(p.customBackgroundOpacity))) }; } catch { return undefined; } }
function saveThemeState(key: string, state: TikzThemeState): void { try { window.localStorage.setItem(themeStorageKey(key), JSON.stringify(state)); } catch { /* storage may be unavailable */ } }

class TikzSourceModal extends Modal {
  constructor(app: App, private readonly initialSource: string, private readonly onRender: (source: string) => Promise<void>) { super(app); }
  onOpen(): void { this.titleEl.empty(); this.contentEl.empty(); const editor = this.contentEl.createEl("textarea", { cls: "tikz-source-editor" }); editor.value = this.initialSource; editor.spellcheck = false; const actions = this.contentEl.createDiv({ cls: "tikz-source-actions" }); actions.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close()); actions.createEl("button", { text: "Render", attr: { type: "button" } }).addEventListener("click", async () => { try { await this.onRender(editor.value); this.close(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } }); editor.focus(); }
}