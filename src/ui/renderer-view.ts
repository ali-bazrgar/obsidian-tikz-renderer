import { App, MarkdownRenderChild, MarkdownView, Modal, Notice } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { DisplayTheme, TikzSettings } from "../settings/settings";

type TikzViewState = { zoom: number; panX: number; panY: number; viewportHeight: number; viewportWidth: number };
type TikzThemeState = { displayTheme: DisplayTheme; customBackgroundColor: string; customBackgroundOpacity: number };

export class TikzRendererView extends MarkdownRenderChild {
  private cleanup?: () => void;
  private sharedStateKey?: string;
  private applyExternalState?: (state: TikzViewState) => void;
  private refreshModeState?: () => void;
  private static readonly activeViews = new Map<string, TikzRendererView>();
  private static readonly allViews = new Set<TikzRendererView>();
  private static wheelWindow?: Window;
  private static wheelHandler?: (event: WheelEvent) => void;
  private static readonly handledWheelEvents = new WeakSet<WheelEvent>();
  private wheelViewport?: HTMLElement;
  private wheelCallback?: (event: WheelEvent) => void;
  private static readonly viewStates = new Map<string, TikzViewState>();
  private static readonly themeStates = new Map<string, TikzThemeState>();

  constructor(private readonly app: App, private readonly exportService: ExportService, host: HTMLElement, private readonly result: RenderResult, private readonly source: string, private readonly sourcePath: string, private readonly service: RenderService, private readonly kind: RenderResult["kind"], private readonly history: TikzHistoryStore, private readonly historyKey: string, private readonly editSource: (source: string) => Promise<void>, private readonly getSettings: () => TikzSettings, private readonly saveSettings: (settings: TikzSettings) => Promise<void>, private readonly confirmAssetLink: () => Promise<boolean>, private readonly syncAssetLink: (assetPath: string) => Promise<void>) { super(host); }

  render(): void {
    this.cleanup?.();
    const stateKey = `${this.sourcePath}::${this.historyKey}`;
    this.sharedStateKey = stateKey;
    // Read and Write keep independent live instances. Obsidian preserves the
    // Live Preview widget while Reading view is shown; disposing the other
    // mode's instance leaves a visible zombie figure with no listeners.
    TikzRendererView.activeViews.set(stateKey, this);
    TikzRendererView.allViews.add(this);
    this.containerEl.empty();
    const doc = this.containerEl.ownerDocument; const win = doc.defaultView;
    const shell = this.containerEl.createDiv({ cls: "tikz-renderer-shell" });
    const viewport = shell.createDiv({ cls: "tikz-renderer-viewport" });
    const resizeHandle = shell.createEl("button", { cls: "tikz-renderer-resize-handle", attr: { type: "button", title: "Resize figure", "aria-label": "Resize TikZ figure" } });
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
    const initialEditState: TikzViewState = persisted ?? { zoom: clampZoom(settings.defaultZoom / 100), panX: 0, panY: 0, viewportHeight: 0, viewportWidth: 0 };
    TikzRendererView.viewStates.set(stateKey, initialEditState);
    let zoom = initialEditState.zoom, panX = initialEditState.panX, panY = initialEditState.panY, naturalWidth = 0, naturalHeight = 0, viewportHeight = initialEditState.viewportHeight, viewportWidth = initialEditState.viewportWidth, dragging = false, resizing = false, lastX = 0, lastY = 0, resizeStartX = 0, resizeStartY = 0, resizeStartWidth = 0, resizeStartHeight = 0;
    let readingMode = false;
    const getCurrentMode = (): "reading" | "writing" => {
      // The renderer's actual DOM position is the authoritative source for
      // this instance. During a Read/Write transition Obsidian can update
      // MarkdownView.getMode() before it finishes moving/rebuilding the
      // renderer DOM. Using getMode() first therefore creates a transient
      // false "reading" state while the figure is already in Write mode.
      if (shell.closest(".markdown-source-view")) return "writing";
      if (shell.closest(".markdown-preview-view")) return "reading";

      // Fallback only for embedded/non-active rendering contexts where the
      // renderer is not currently inside either standard Markdown container.
      const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
      return markdownView?.getMode() === "preview" ? "reading" : "writing";
    };
    const isReadingMode = (): boolean => getCurrentMode() === "reading";
    const isWritableHost = (): boolean => rendererHostIsWritable(shell);
    const hostIsVisible = (): boolean => rendererHostIsVisible(shell);
    const closePanel = (): void => { panel.hidden = true; menu.setAttribute("aria-expanded", "false"); menu.removeAttribute("data-open"); };

    const getViewportParentWidth = (): number => Math.max(1, Math.round(shell.parentElement?.clientWidth || this.containerEl.clientWidth || naturalWidth || 1));
    const getViewportWidth = (): number => Math.max(1, Math.round(shell.clientWidth || this.containerEl.clientWidth || viewport.getBoundingClientRect().width || naturalWidth));
    const getViewportHeight = (): number => Math.max(1, Math.round(viewport.clientHeight || viewportHeight || naturalHeight * zoom || 1));
    const syncViewportGeometry = (): void => {
      if (viewportWidth > 0) {
        viewportWidth = Math.min(clampViewportWidth(viewportWidth), getViewportParentWidth());
        shell.style.width = `${viewportWidth}px`;
      } else {
        shell.style.removeProperty("width");
      }
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
      viewportWidth = Number.isFinite(state.viewportWidth) && state.viewportWidth > 0 ? clampViewportWidth(state.viewportWidth) : 0;
      if (Number.isFinite(state.viewportHeight) && state.viewportHeight > 0) viewportHeight = clampViewportHeight(state.viewportHeight);
      if (naturalWidth > 0 && naturalHeight > 0) { svg.style.width = `${naturalWidth * zoom}px`; svg.style.height = `${naturalHeight * zoom}px`; svg.style.maxWidth = "none"; }
      syncViewportGeometry(); clampCurrentPan(); applySvgTransform();
      viewport.classList.toggle("is-pannable", isWritableHost() && zoom > 1); viewport.style.touchAction = "none";
    };
    const syncSharedState = (): boolean => { const shared = TikzRendererView.viewStates.get(stateKey); if (!shared) return false; const changed = zoom !== shared.zoom || panX !== shared.panX || panY !== shared.panY || viewportHeight !== shared.viewportHeight || viewportWidth !== shared.viewportWidth; if (changed) applyLocalViewState(shared); return changed; };
    const updateMode = (): boolean => {
      // A host inside Live Preview / source view is always writable, even if
      // MarkdownView.getMode() already flipped to preview during a transition.
      const nextReadingMode = isWritableHost() ? false : isReadingMode();
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
      // Visibility of the ⋯ button is owned by CSS from the actual Markdown
      // container. Never stamp [hidden] here: a stale readingMode would disable
      // the button after a Read ↔ Write toggle.
      if (nextReadingMode) closePanel();
      resizeHandle.hidden = nextReadingMode;
      return changedMode;
    };
    const persistViewState = (): void => {
      if (!isWritableHost()) return;
      clampCurrentPan();
      const state = { zoom, panX, panY, viewportHeight: clampViewportHeight(viewportHeight), viewportWidth: viewportWidth > 0 ? clampViewportWidth(viewportWidth) : 0 };
      TikzRendererView.viewStates.set(stateKey, state);
      saveViewState(stateKey, state);
      for (const view of TikzRendererView.allViews) {
        if (view !== this && view.sharedStateKey === stateKey) view.applyExternalState?.(state);
      }
    };
    const positionPanel = (): void => { if (panel.hidden || !shell.isConnected || !isWritableHost()) return; const b = menu.getBoundingClientRect(); const vw = win?.innerWidth ?? doc.documentElement.clientWidth; const vh = win?.innerHeight ?? doc.documentElement.clientHeight; const width = Math.min(270, Math.max(230, vw - 16)); panel.style.width = `${width}px`; const r = panel.getBoundingClientRect(); let left = b.left; let top = b.bottom + 6; if (left + r.width > vw - 8) left = Math.max(8, vw - r.width - 8); if (left < 8) left = 8; if (top + r.height > vh - 8) top = b.top - r.height - 6; if (top < 8) top = 8; panel.style.left = `${Math.round(left)}px`; panel.style.top = `${Math.round(top)}px`; };
    const applyTheme = (): void => { const theme = themeState.displayTheme === "auto" ? detectTheme(doc) : themeState.displayTheme; shell.dataset.theme = theme; if (theme === "custom") { shell.style.setProperty("--tikz-custom-bg", themeState.customBackgroundColor); shell.style.setProperty("--tikz-custom-bg-opacity", `${themeState.customBackgroundOpacity / 100}`); } else { shell.style.removeProperty("--tikz-custom-bg"); shell.style.removeProperty("--tikz-custom-bg-opacity"); } };
    const persistTheme = (): void => { TikzRendererView.themeStates.set(stateKey, { ...themeState }); saveThemeState(stateKey, themeState); applyTheme(); };
    const ensureIntrinsicSize = (): boolean => { if (naturalWidth > 0 && naturalHeight > 0) return true; const b = svg.viewBox?.baseVal; if (b && b.width > 0 && b.height > 0) { naturalWidth = b.width; naturalHeight = b.height; return true; } const w = Number.parseFloat(svg.getAttribute("width") ?? ""); const h = Number.parseFloat(svg.getAttribute("height") ?? ""); if (w > 0 && h > 0) { naturalWidth = w; naturalHeight = h; return true; } return false; };
    const ensureViewportSize = (): void => { if (!ensureIntrinsicSize()) return; if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) viewportHeight = clampViewportHeight(naturalHeight * zoom); syncViewportGeometry(); clampCurrentPan(); };
    const applyZoom = (): void => { ensureViewportSize(); if (naturalWidth > 0 && naturalHeight > 0) { svg.style.width = `${naturalWidth * zoom}px`; svg.style.height = `${naturalHeight * zoom}px`; svg.style.maxWidth = "none"; } syncViewportGeometry(); clampCurrentPan(); applySvgTransform(); viewport.classList.toggle("is-pannable", isWritableHost() && zoom > 1); viewport.classList.toggle("is-dragging", dragging); viewport.style.touchAction = "none"; applyTheme(); updateMode(); positionPanel(); };
    const resetView = (): void => { if (!isWritableHost()) return; zoom = clampZoom(settings.defaultZoom / 100); panX = 0; panY = 0; viewportWidth = 0; viewportHeight = clampViewportHeight(naturalHeight * zoom); persistViewState(); applyZoom(); };
    const fit = (): void => { if (!isWritableHost() || !ensureIntrinsicSize()) return; const width = getViewportWidth(); zoom = clampZoom(Math.min(1, width / naturalWidth)); panX = 0; panY = 0; viewportHeight = clampViewportHeight(naturalHeight * zoom); persistViewState(); applyZoom(); };
    const addButton = (label: string, action: () => void | Promise<void>): void => { const b = panel.createEl("button", { text: label, attr: { type: "button", role: "menuitem" } }); b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); void action(); }); };
    const exportPng = async (): Promise<void> => {
      if (!isWritableHost()) return;
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
    const buildMainPanel = (): void => { panel.empty(); panel.createDiv({ cls: "tikz-renderer-panel-title", text: "TikZ controls" }); addButton("Zoom −", () => { if (!isWritableHost()) return; const oldZoom = zoom; const nextZoom = clampZoom(oldZoom - .25); if (nextZoom !== oldZoom) zoom = nextZoom; persistViewState(); applyZoom(); }); addButton("Zoom +", () => { if (!isWritableHost()) return; const oldZoom = zoom; const nextZoom = clampZoom(oldZoom + .25); if (nextZoom !== oldZoom) zoom = nextZoom; persistViewState(); applyZoom(); }); addButton("Reset view", resetView); addButton("Fit", fit); addButton("Theme", renderThemeMenu); addButton("Export PNG", exportPng); addButton("Edit source", () => new TikzSourceModal(this.app, this.source, async next => this.editSource(next)).open()); addButton("History", () => { panel.empty(); panel.createDiv({ cls: "tikz-renderer-panel-title", text: "History" }); const entries = this.history.list(this.historyKey); for (const [i, entry] of entries.entries()) { const row = panel.createDiv({ cls: "tikz-history-row" }); row.createSpan({ text: `Version ${entries.length - i}` }); row.createSpan({ text: new Date(entry.timestamp).toLocaleString() }); if (entry.source !== this.source) row.createEl("button", { text: "Restore", attr: { type: "button" } }).addEventListener("click", () => new TikzSourceModal(this.app, entry.source, async next => this.editSource(next)).open()); } panel.createEl("button", { text: "Back", attr: { type: "button" } }).addEventListener("click", () => buildMainPanel()); }); addButton("Re-render", async () => { const next = await this.service.render(this.source, this.kind, this.sourcePath); this.result.svg = next.svg; this.result.hash = next.hash; this.result.engine = next.engine; this.result.fromCache = next.fromCache; const createLink = await this.confirmAssetLink(); this.result.assetPath = createLink ? await this.exportService.saveSvg(next.svg, next.hash, this.sourcePath, false) : undefined; await this.syncAssetLink(this.result.assetPath ?? ""); closePanel(); this.render(); }); addButton("Copy source", async () => { await navigator.clipboard.writeText(this.source); new Notice("TikZ source copied."); }); if (this.result.assetPath) showAssetActions(); };
    const openPanel = (): void => {
      if (!shell.isConnected || !isWritableHost()) return;
      panel.hidden = false;
      menu.setAttribute("aria-expanded", "true");
      menu.setAttribute("data-open", "true");
      buildMainPanel();
      positionPanel();
    };
    const togglePanel = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as PointerEvent).stopImmediatePropagation === "function") (e as PointerEvent).stopImmediatePropagation();
      if (e instanceof PointerEvent && e.button !== 0) return;
      if (!isWritableHost()) return;
      if (panel.hidden) openPanel();
      else closePanel();
    };
    menu.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && isWritableHost()) togglePanel(e);
    });
    // Pointer-down is the single activation event for the control. Using both
    // pointerdown and click would toggle twice: pointerdown opens the panel and
    // the synthetic click immediately closes it again.
    menu.addEventListener("pointerdown", togglePanel, true);
    menu.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); }, true);
    const outsidePointerDown = (e: PointerEvent): void => { if (!panel.hidden && (!(e.target instanceof Node) || (!shell.contains(e.target) && !panel.contains(e.target)))) closePanel(); }; doc.addEventListener("pointerdown", outsidePointerDown, true);
    const escape = (e: KeyboardEvent): void => { if (e.key === "Escape" && !panel.hidden) { closePanel(); menu.focus(); } }; doc.addEventListener("keydown", escape, true);
    svg.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); });
    viewport.addEventListener("pointerdown", e => {
      if (!isWritableHost() || e.button !== 0 || zoom <= 1) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY; viewport.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    viewport.addEventListener("pointermove", e => { if (!dragging) return; panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; clampCurrentPan(); applySvgTransform(); e.preventDefault(); e.stopPropagation(); });
    const stopDragging = (): void => { if (!dragging) return; dragging = false; clampCurrentPan(); persistViewState(); viewport.classList.remove("is-dragging"); };
    viewport.addEventListener("pointerup", stopDragging); viewport.addEventListener("pointercancel", stopDragging); viewport.addEventListener("lostpointercapture", stopDragging);
    const beginResize = (e: PointerEvent): void => {
      if (!isWritableHost() || e.button !== 0) return;
      const currentWidth = getViewportWidth();
      const currentHeight = getViewportHeight();
      resizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartWidth = currentWidth;
      resizeStartHeight = currentHeight;
      resizeHandle.setPointerCapture(e.pointerId);
      viewport.classList.add("is-resizing");
      e.preventDefault();
      e.stopPropagation();
    };
    const moveResize = (e: PointerEvent): void => {
      if (!resizing) return;
      viewportWidth = Math.min(clampViewportWidth(resizeStartWidth + e.clientX - resizeStartX), getViewportParentWidth());
      viewportHeight = clampViewportHeight(resizeStartHeight + e.clientY - resizeStartY);
      syncViewportGeometry();
      applySvgTransform();
      e.preventDefault();
      e.stopPropagation();
    };
    const finishResize = (): void => {
      if (!resizing) return;
      resizing = false;
      viewport.classList.remove("is-resizing");
      persistViewState();
      applyZoom();
    };
    resizeHandle.addEventListener("pointerdown", beginResize, true);
    resizeHandle.addEventListener("pointermove", moveResize, true);
    resizeHandle.addEventListener("pointerup", finishResize, true);
    resizeHandle.addEventListener("pointercancel", finishResize, true);
    resizeHandle.addEventListener("lostpointercapture", finishResize, true);
    resizeHandle.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); });
    resizeHandle.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); }, true);
    resizeHandle.addEventListener("keydown", e => {
      if (!isWritableHost()) return;
      const step = e.shiftKey ? 40 : 10;
      let changed = false;
      if (e.key === "ArrowRight") { viewportWidth = Math.min(clampViewportWidth(getViewportWidth() + step), getViewportParentWidth()); changed = true; }
      else if (e.key === "ArrowLeft") { viewportWidth = Math.max(120, getViewportWidth() - step); changed = true; }
      else if (e.key === "ArrowDown") { viewportHeight = clampViewportHeight(getViewportHeight() + step); changed = true; }
      else if (e.key === "ArrowUp") { viewportHeight = clampViewportHeight(getViewportHeight() - step); changed = true; }
      else if (e.key === "Home") { viewportWidth = 0; viewportHeight = clampViewportHeight(naturalHeight * zoom); changed = true; }
      if (changed) {
        e.preventDefault();
        e.stopPropagation();
        syncViewportGeometry();
        applySvgTransform();
        persistViewState();
        applyZoom();
      }
    });
    const wheel = (e: WheelEvent): void => {
      if (!shell.isConnected) return;
      if (!isWritableHost() || !hostIsVisible()) return;
      // Hit-testing is performed by the single delegated window listener.
      // Do not require the wheel event target to be a descendant of this
      // viewport: during Read/Write transitions Obsidian may deliver the event
      // to a CodeMirror/container element even while the pointer is over the
      // rendered figure.
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      if (!ensureIntrinsicSize()) return;
      // The renderer has both a delegated window listener and a direct
      // viewport listener so it remains robust to Obsidian/CodeMirror event
      // interception during mode transitions. Only the first listener that
      // actually handles a wheel event may mutate zoom/state.
      if (TikzRendererView.handledWheelEvents.has(e)) return;
      TikzRendererView.handledWheelEvents.add(e);

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
    this.wheelViewport = viewport;
    this.wheelCallback = wheel;
    // Direct capture keeps wheel zoom alive even when an editor-level
    // listener interferes with delegated window handling during transitions.
    // The global listener remains as the fallback for overlay-delivered events.
    viewport.addEventListener("wheel", wheel, { passive: false, capture: true });
    TikzRendererView.ensureGlobalWheelListener(win);
    const observer = new MutationObserver(() => {
      const changed = updateMode();
      if (changed) applyZoom();
      else if (!panel.hidden) positionPanel();
    });
    observer.observe(doc.body, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(() => {
      ensureViewportSize();
      positionPanel();
    });
    resizeObserver.observe(viewport);
    const reposition = (): void => positionPanel(); win?.addEventListener("scroll", reposition, true); win?.addEventListener("resize", reposition);
    buildMainPanel(); closePanel(); updateMode(); applyTheme(); ensureIntrinsicSize(); ensureViewportSize(); applyZoom();
    this.refreshModeState = (): void => {
      const changed = updateMode();
      if (changed) applyZoom();
      else {
        applyTheme();
        if (!panel.hidden) positionPanel();
      }
    };
    this.applyExternalState = (state: TikzViewState): void => { applyLocalViewState(state); };
    this.cleanup = () => { if (TikzRendererView.activeViews.get(stateKey) === this) TikzRendererView.activeViews.delete(stateKey); doc.removeEventListener("pointerdown", outsidePointerDown, true); doc.removeEventListener("keydown", escape, true); menu.removeEventListener("pointerdown", togglePanel, true); resizeHandle.removeEventListener("pointerdown", beginResize, true); resizeHandle.removeEventListener("pointermove", moveResize, true); resizeHandle.removeEventListener("pointerup", finishResize, true); resizeHandle.removeEventListener("pointercancel", finishResize, true); resizeHandle.removeEventListener("lostpointercapture", finishResize, true); viewport.removeEventListener("wheel", wheel, true); this.wheelViewport = undefined; this.wheelCallback = undefined; win?.removeEventListener("scroll", reposition, true); win?.removeEventListener("resize", reposition); observer.disconnect(); resizeObserver.disconnect(); closePanel(); panel.remove(); TikzRendererView.allViews.delete(this); TikzRendererView.removeGlobalWheelListenerIfUnused(); this.applyExternalState = undefined; this.refreshModeState = undefined; this.cleanup = undefined; };
  }
  onunload(): void { this.cleanup?.(); this.containerEl.empty(); }
  dispose(emptyContainer = true): void { this.cleanup?.(); if (emptyContainer && this.containerEl.isConnected) this.containerEl.empty(); }
  private static ensureGlobalWheelListener(win: Window | null): void {
    if (!win) return;
    if (this.wheelHandler && this.wheelWindow === win) return;
    if (this.wheelHandler && this.wheelWindow && this.wheelWindow !== win) {
      this.wheelWindow.removeEventListener("wheel", this.wheelHandler, true);
      this.wheelHandler = undefined;
      this.wheelWindow = undefined;
    }
    this.wheelWindow = win;
    this.wheelHandler = (event: WheelEvent): void => {
      // Obsidian/CodeMirror may already call preventDefault() for editor
      // scrolling before our window listener runs. That must NOT disable the
      // TikZ zoom handler; we handle the wheel independently and also prevent
      // the editor's default scrolling below when the pointer is over a figure.

      const liveViews = Array.from(this.allViews).reverse().filter(view => {
        const element = view.wheelViewport;
        return !!element && rendererHostIsVisible(element) && rendererHostIsWritable(element);
      });

      // First prefer the actual event path. This is the normal case.
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const view of liveViews) {
        if (path.includes(view.wheelViewport!)) {
          view.wheelCallback?.(event);
          if (event.defaultPrevented) return;
        }
      }

      // During an Obsidian Read/Write transition, CodeMirror/Obsidian may be
      // the event target even though the pointer is visually over the figure.
      // Use the viewport's screen geometry as a fallback instead of assuming
      // that the event target must be a descendant of the viewport.
      const x = event.clientX;
      const y = event.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      for (const view of liveViews) {
        const element = view.wheelViewport!;
        if (path.includes(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          view.wheelCallback?.(event);
          if (event.defaultPrevented) return;
        }
      }
    };
    win.addEventListener("wheel", this.wheelHandler, { passive: false, capture: true });
  }

  private static removeGlobalWheelListenerIfUnused(): void {
    if (this.allViews.size > 0 || !this.wheelWindow || !this.wheelHandler) return;
    this.wheelWindow.removeEventListener("wheel", this.wheelHandler, true);
    this.wheelWindow = undefined;
    this.wheelHandler = undefined;
  }

  static syncAllModes(): void {
    for (const view of Array.from(this.allViews)) view.refreshModeState?.();
  }

  static disposeAll(): void {
    for (const view of Array.from(this.allViews)) view.dispose(true);
    this.activeViews.clear();
    this.allViews.clear();
    this.removeGlobalWheelListenerIfUnused();
  }
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
export function rendererHostIsWritable(el: { closest(selectors: string): unknown } | null | undefined): boolean {
  return !!el?.closest(".markdown-source-view");
}
export function rendererHostIsVisible(el: HTMLElement | null | undefined): boolean {
  if (!el?.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const view = el.ownerDocument.defaultView;
  let node: HTMLElement | null = el;
  while (node && view) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    node = node.parentElement;
  }
  return true;
}
function clampZoom(value: number): number { return Math.min(5, Math.max(.25, value)); }
function clampViewportHeight(value: number): number { return Math.min(1600, Math.max(80, value)); }
function clampViewportWidth(value: number): number { return Math.min(2400, Math.max(120, value)); }
function clampNumber(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function viewStorageKey(key: string): string { return `obsidian-tikz-renderer:view:${key}`; }
function themeStorageKey(key: string): string { return `obsidian-tikz-renderer:theme:${key}`; }
function loadViewState(key: string): TikzViewState | undefined { try { const raw = window.localStorage.getItem(viewStorageKey(key)); if (!raw) return undefined; const p = JSON.parse(raw) as Partial<TikzViewState>; if (!Number.isFinite(p.zoom) || !Number.isFinite(p.panX) || !Number.isFinite(p.panY)) return undefined; return { zoom: clampZoom(Number(p.zoom)), panX: Number(p.panX), panY: Number(p.panY), viewportHeight: Number.isFinite(p.viewportHeight) ? clampViewportHeight(Number(p.viewportHeight)) : 0, viewportWidth: Number.isFinite(p.viewportWidth) && Number(p.viewportWidth) > 0 ? clampViewportWidth(Number(p.viewportWidth)) : 0 }; } catch { return undefined; } }
function saveViewState(key: string, state: TikzViewState): void { try { window.localStorage.setItem(viewStorageKey(key), JSON.stringify(state)); } catch { /* storage may be unavailable */ } }
function loadThemeState(key: string): TikzThemeState | undefined { try { const raw = window.localStorage.getItem(themeStorageKey(key)); if (!raw) return undefined; const p = JSON.parse(raw) as Partial<TikzThemeState>; if (typeof p.displayTheme !== "string" || typeof p.customBackgroundColor !== "string" || !Number.isFinite(p.customBackgroundOpacity)) return undefined; return { displayTheme: p.displayTheme as DisplayTheme, customBackgroundColor: p.customBackgroundColor, customBackgroundOpacity: Math.min(100, Math.max(10, Number(p.customBackgroundOpacity))) }; } catch { return undefined; } }
function saveThemeState(key: string, state: TikzThemeState): void { try { window.localStorage.setItem(themeStorageKey(key), JSON.stringify(state)); } catch { /* storage may be unavailable */ } }

class TikzSourceModal extends Modal {
  constructor(app: App, private readonly initialSource: string, private readonly onRender: (source: string) => Promise<void>) { super(app); }
  onOpen(): void { this.titleEl.empty(); this.contentEl.empty(); const editor = this.contentEl.createEl("textarea", { cls: "tikz-source-editor" }); editor.value = this.initialSource; editor.spellcheck = false; const actions = this.contentEl.createDiv({ cls: "tikz-source-actions" }); actions.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close()); actions.createEl("button", { text: "Render", attr: { type: "button" } }).addEventListener("click", async () => { try { await this.onRender(editor.value); this.close(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); } }); editor.focus(); }
}