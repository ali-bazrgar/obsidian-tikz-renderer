import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
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

interface Fence {
  from: number;
  to: number;
  language: string;
}

const FENCE = /(^|\n)(```(tikz|pgfplots|circuitikz|tex|latex)\n)([\s\S]*?)(\n```)(?=\n|$)/g;

export const tikzLivePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (decorations, transaction) => {
    if (!transaction.docChanged && !transaction.selection) return decorations;
    return buildDecorations(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const selections = state.selection.ranges;
  const text = state.doc.toString();
  FENCE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FENCE.exec(text)) !== null) {
    const linePrefix = match[1] ?? "";
    const fenceStart = match.index + linePrefix.length;
    const fenceEnd = fenceStart + match[2].length + match[4].length + match[5].length;
    const language = match[3];
    const fence: Fence = { from: fenceStart, to: fenceEnd, language };

    // Never replace a block while the user's selection/cursor is inside it.
    if (selections.some((range) => range.from <= fence.to && range.to >= fence.from)) continue;

    builder.add(
      fence.from,
      fence.to,
      Decoration.replace({
        widget: new TikzPlaceholderWidget(fence.language),
        block: true,
      }),
    );
  }

  return builder.finish();
}

export const tikzLivePreviewExtension = [tikzLivePreviewField];

export class TikzLivePreviewLifecycle {
  private readonly extension = tikzLivePreviewField;

  update(_update: ViewUpdate): void {
    // Reserved for the asynchronous SVG renderer integration. Rendering must not
    // run inside decoration calculation or block the CodeMirror update cycle.
  }

  getExtension(): typeof tikzLivePreviewField { return this.extension; }
}

export const tikzLivePreviewPlugin = ViewPlugin.fromClass(TikzLivePreviewLifecycle);
