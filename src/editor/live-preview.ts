import { EditorView, Decoration, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { EditorState, Range, StateField, StateEffect } from "@codemirror/state";

const setRanges = StateEffect.define<Range<Decoration>[]>();

class TikzWidget extends WidgetType {
  constructor(private readonly label: string) { super(); }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "tikz-live-preview-widget";
    el.textContent = this.label;
    el.setAttribute("aria-label", "TikZ preview");
    return el;
  }
  ignoreEvent(): boolean { return false; }
}

export const tikzLivePreviewField = StateField.define<Range<Decoration>[]>({
  create: () => [],
  update(ranges, transaction) {
    ranges = ranges.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setRanges)) ranges = effect.value;
    return ranges;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const fencePattern = /(^|\n)(```(?:tikz|pgfplots|circuitikz|tex|latex)\n)([\s\S]*?)(\n```)(?=\n|$)/g;

class LivePreviewController {
  private lastText = "";
  private disposed = false;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (this.disposed || !update.docChanged && !update.viewportChanged) return;
    this.recompute();
  }

  destroy(): void { this.disposed = true; }

  private recompute(): void {
    const text = this.view.state.doc.toString();
    if (text === this.lastText) return;
    this.lastText = text;
    const ranges: Range<Decoration>[] = [];
    fencePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = fencePattern.exec(text)) !== null) {
      const start = match.index + (match[1]?.length ?? 0);
      const fenceStart = start;
      const contentStart = start + match[2].length;
      const contentEnd = contentStart + match[3].length;
      const fenceEnd = contentEnd + match[4].length;
      if (contentEnd <= contentStart || fenceEnd <= fenceStart) continue;
      const widget = Decoration.widget({ widget: new TikzWidget(`[TikZ ${match[2].trim().slice(3)}]`), side: -1 });
      ranges.push(widget.range(fenceStart));
      ranges.push(Decoration.mark({ class: "tikz-live-preview-hidden" }).range(fenceStart, fenceEnd));
    }
    this.view.dispatch({ effects: setRanges.of(ranges) });
  }
}

export const tikzLivePreviewPlugin = ViewPlugin.fromClass(LivePreviewController);
export const tikzLivePreviewExtension = [tikzLivePreviewField, tikzLivePreviewPlugin];
