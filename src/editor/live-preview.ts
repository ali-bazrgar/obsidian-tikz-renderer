import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";

class TikzPlaceholderWidget extends WidgetType {
  constructor(private readonly language: string) { super(); }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "tikz-live-preview-widget";
    element.textContent = `TikZ Renderer · ${this.language}`;
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", `TikZ ${this.language} preview placeholder`);
    return element;
  }

  ignoreEvent(): boolean { return false; }
}

const FENCE = /(^|\n)(```(tikz|pgfplots|circuitikz|tex|latex)\n)([\s\S]*?)(\n```)(?=\n|$)/g;

/**
 * Live Preview decoration layer.
 *
 * Block replacement is deliberately provided by a StateField rather than a
 * ViewPlugin. CodeMirror 6 forbids block decorations supplied directly by a
 * view plugin. The field also leaves the source untouched whenever the
 * selection intersects a TikZ fence, preserving normal editing semantics.
 */
export const tikzLivePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (decorations, transaction) => {
    if (!transaction.docChanged && !transaction.selection) return decorations;
    return buildDecorations(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const tikzLivePreviewExtension = [tikzLivePreviewField];

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const selections = state.selection.ranges;
  const text = state.doc.toString();
  FENCE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FENCE.exec(text)) !== null) {
    const linePrefixLength = (match[1] ?? "").length;
    const fenceStart = match.index + linePrefixLength;
    const fenceEnd = fenceStart + match[2].length + match[4].length + match[5].length;

    if (selections.some((range) => range.from < fenceEnd && range.to > fenceStart)) continue;

    builder.add(
      fenceStart,
      fenceEnd,
      Decoration.replace({
        widget: new TikzPlaceholderWidget(match[3]),
        block: true,
      }),
    );
  }

  return builder.finish();
}
