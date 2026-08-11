import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { BlockKind } from "../core/types";
import { RenderService } from "../core/render-service";

const LANGUAGES = new Set<BlockKind>(["tikz", "pgfplots", "circuitikz", "tex", "latex"]);

interface TikzFence {
  from: number;
  to: number;
  language: BlockKind;
  source: string;
}

class TikzPreviewWidget extends WidgetType {
  private element: HTMLElement | null = null;
  private generation = 0;

  constructor(
    private readonly fence: TikzFence,
    private readonly renderService: RenderService,
  ) { super(); }

  toDOM(): HTMLElement {
    const generation = ++this.generation;
    const root = document.createElement("div");
    root.className = "tikz-live-preview-widget tikz-live-preview-widget--loading";
    root.setAttribute("role", "figure");
    root.setAttribute("aria-label", `TikZ ${this.fence.language} preview`);

    const header = root.createDiv({ cls: "tikz-live-preview-widget__header" });
    header.createSpan({ cls: "tikz-live-preview-widget__title", text: "TikZ Renderer" });
    header.createSpan({ cls: "tikz-live-preview-widget__status", text: "Rendering…" });

    const body = root.createDiv({ cls: "tikz-live-preview-widget__body" });
    body.createSpan({ cls: "tikz-live-preview-widget__placeholder", text: `${this.fence.language} · rendering` });
    this.element = root;

    void this.render(body, root, generation);
    return root;
  }

  /** Invalidate pending DOM updates when CodeMirror discards this widget. */
  destroy(dom: HTMLElement): void {
    this.generation += 1;
    if (this.element === dom) this.element = null;
  }

  ignoreEvent(): boolean { return false; }

  eq(other: WidgetType): boolean {
    return other instanceof TikzPreviewWidget &&
      other.fence.language === this.fence.language &&
      other.fence.source === this.fence.source &&
      other.fence.from === this.fence.from &&
      other.fence.to === this.fence.to;
  }

  private async render(body: HTMLElement, root: HTMLElement, generation: number): Promise<void> {
    try {
      const result = await this.renderService.render(this.fence.source, this.fence.language);
      if (!this.isCurrent(root, generation)) return;

      body.empty();
      const image = body.createEl("img", {
        cls: "tikz-live-preview-widget__svg",
        attr: {
          src: svgDataUri(result.svg),
          alt: `Rendered TikZ ${this.fence.language}`,
          draggable: "false",
        },
      });
      image.addEventListener("load", () => {
        if (this.isCurrent(root, generation)) root.classList.remove("tikz-live-preview-widget--loading");
      }, { once: true });
      root.querySelector<HTMLElement>(".tikz-live-preview-widget__status")?.setText("Ready");
    } catch (error) {
      if (!this.isCurrent(root, generation)) return;
      root.classList.remove("tikz-live-preview-widget--loading");
      root.classList.add("tikz-live-preview-widget--error");
      body.empty();
      const errorBox = body.createDiv({ cls: "tikz-live-preview-widget__error" });
      errorBox.createEl("strong", { text: "TikZ rendering failed" });
      errorBox.createEl("pre", { text: error instanceof Error ? error.message : String(error) });
      root.querySelector<HTMLElement>(".tikz-live-preview-widget__status")?.setText("Error");
      console.error("[TikZ Renderer] Live Preview render failed", error);
    }
  }

  private isCurrent(root: HTMLElement, generation: number): boolean {
    return this.element === root && this.generation === generation && root.isConnected;
  }
}

/**
 * Live Preview decoration layer.
 *
 * Block replacement is provided by a StateField, not a ViewPlugin. The
 * asynchronous TeX compilation happens only after the widget enters the DOM;
 * CodeMirror's state update path therefore remains synchronous and cheap.
 */
export function createTikzLivePreviewExtension(renderService: RenderService) {
  return StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, renderService),
    update: (decorations, transaction) => {
      if (!transaction.docChanged && !transaction.selection) return decorations;
      return buildDecorations(transaction.state, renderService);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

export function createTikzLivePreviewExtensions(renderService: RenderService) {
  return [createTikzLivePreviewExtension(renderService)];
}

function buildDecorations(state: EditorState, renderService: RenderService): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = state.doc.toString();
  const fences = findFences(text);

  for (const fence of fences) {
    if (state.selection.ranges.some((range) => intersects(range.from, range.to, fence.from, fence.to))) continue;
    builder.add(
      fence.from,
      fence.to,
      Decoration.replace({
        widget: new TikzPreviewWidget(fence, renderService),
        block: true,
      }),
    );
  }
  return builder.finish();
}

function findFences(text: string): TikzFence[] {
  const result: TikzFence[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let active: { start: number; language: BlockKind; contentStart: number } | null = null;

  for (const line of lines) {
    const match = /^```(tikz|pgfplots|circuitikz|tex|latex)\s*$/u.exec(line);
    if (!active && match && LANGUAGES.has(match[1] as BlockKind)) {
      active = { start: offset, language: match[1] as BlockKind, contentStart: offset + line.length + 1 };
    } else if (active && /^```\s*$/u.test(line)) {
      const contentEnd = offset;
      result.push({
        from: active.start,
        to: offset + line.length,
        language: active.language,
        source: text.slice(active.contentStart, contentEnd).trim(),
      });
      active = null;
    }
    offset += line.length + 1;
  }
  return result;
}

function intersects(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && aTo >= bFrom;
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
