import { MarkdownPostProcessorContext } from "obsidian";
import { BlockKind } from "../core/types";
import { RenderService } from "../core/render-service";
import { TikzRendererView } from "../ui/renderer-view";

export class TikzMarkdownProcessor {
  static async process(kind: BlockKind, source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext, service: RenderService): Promise<void> {
    const host = el.createDiv({ cls: "tikz-renderer-block" });
    el.empty();
    host.createDiv({ cls: "tikz-renderer-status", text: "Rendering TikZ…" });

    try {
      const result = await service.render(source, kind);
      if (!el.isConnected) return;
      new TikzRendererView(host, result, source, service, kind).render();
    } catch (error) {
      if (!el.isConnected) return;
      host.empty();
      const card = host.createDiv({ cls: "tikz-renderer-error" });
      card.createEl("strong", { text: "TeX/TikZ rendering failed" });
      card.createEl("pre", { text: error instanceof Error ? error.message : String(error) });
    }
  }
}
