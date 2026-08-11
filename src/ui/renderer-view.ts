import { Notice, setIcon } from "obsidian";
import { RenderResult } from "../core/types";
import { RenderService } from "../core/render-service";

export class TikzRendererView {
  constructor(
    private readonly host: HTMLElement,
    private readonly result: RenderResult,
    private readonly source: string,
    private readonly service: RenderService,
    private readonly kind: RenderResult["kind"],
  ) {}

  render(): void {
    this.host.empty();
    const root = this.host.createDiv({ cls: "tikz-renderer" });
    const toolbar = root.createDiv({ cls: "tikz-renderer-toolbar" });
    toolbar.createSpan({ text: "TikZ Renderer", cls: "tikz-renderer-title" });
    const menu = toolbar.createEl("button", { cls: "tikz-renderer-menu", attr: { "aria-label": "TikZ controls", type: "button" } });
    setIcon(menu, "more-vertical");

    const canvas = root.createDiv({ cls: "tikz-renderer-canvas" });
    const viewport = canvas.createDiv({ cls: "tikz-renderer-viewport" });
    const img = viewport.createEl("img", { cls: "tikz-renderer-svg", attr: { alt: "TikZ diagram", draggable: "false" } });
    img.src = `data:image/svg+xml;base64,${encodeBase64(this.result.svg)}`;

    let zoom = 1;
    let x = 0;
    let y = 0;
    const apply = (): void => {
      img.style.transformOrigin = "center center";
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
    };

    const panel = root.createDiv({ cls: "tikz-renderer-panel" });
    panel.hidden = true;
    menu.addEventListener("click", () => { panel.hidden = !panel.hidden; });

    const button = (label: string, action: () => void | Promise<void>): void => {
      const el = panel.createEl("button", { text: label, attr: { type: "button" } });
      el.addEventListener("click", () => void action());
    };

    button("−", () => { zoom = Math.max(0.25, zoom - 0.25); apply(); });
    button("Reset", () => { zoom = 1; x = 0; y = 0; apply(); });
    button("+", () => { zoom = Math.min(5, zoom + 0.25); apply(); });
    button("Fit", () => {
      const width = viewport.clientWidth;
      if (width > 0 && img.naturalWidth > 0) zoom = Math.min(1, width / img.naturalWidth);
      x = 0;
      y = 0;
      apply();
    });
    button("Copy source", async () => { await navigator.clipboard.writeText(this.source); new Notice("TikZ source copied."); });
    button("Copy embed", async () => {
      await navigator.clipboard.writeText(`\`\`\`${this.kind}\n${this.source}\n\`\`\``);
      new Notice("TikZ embed copied.");
    });
    button("Export SVG", () => {
      const blob = new Blob([this.result.svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${this.result.hash}.svg`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
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
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      x += event.clientX - lastX;
      y += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      apply();
    });
    viewport.addEventListener("pointerup", () => { dragging = false; });
    viewport.addEventListener("pointercancel", () => { dragging = false; });
    apply();
  }
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
