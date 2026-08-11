import { App, MarkdownPostProcessorContext, MarkdownSectionInformation, TFile } from "obsidian";
import { createHash } from "node:crypto";
import { BlockKind } from "../core/types";
import { RenderService } from "../core/render-service";
import { TikzHistoryStore } from "../core/history";
import { TikzRendererView } from "../ui/renderer-view";

export class TikzMarkdownProcessor {
  static async process(app: App, history: TikzHistoryStore, kind: BlockKind, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, service: RenderService): Promise<void> {
    const host = el.createDiv({ cls: "tikz-renderer-block" });
    el.empty(); host.createDiv({ cls: "tikz-renderer-status", text: "Rendering TikZ…" });
    const section = ctx.getSectionInfo(el);
    const historyKey = makeHistoryKey(ctx, section, kind, source);
    history.record(historyKey, source);
    try {
      const result = await service.render(source, kind);
      if (!el.isConnected) return;
      new TikzRendererView(app, host, result, source, service, kind, history, historyKey, async (nextSource) => {
        await replaceSource(app, ctx, el, kind, nextSource);
      }).render();
    } catch (error) {
      if (!el.isConnected) return;
      host.empty(); const card = host.createDiv({ cls: "tikz-renderer-error" });
      card.createEl("strong", { text: "TeX/TikZ rendering failed" });
      card.createEl("pre", { text: error instanceof Error ? error.message : String(error) });
    }
  }
}

function makeHistoryKey(ctx: MarkdownPostProcessorContext, section: MarkdownSectionInformation | null, kind: BlockKind, source: string): string {
  const location = section ? `${section.lineStart}-${section.lineEnd}` : createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${ctx.sourcePath}:${location}:${kind}`;
}

async function replaceSource(app: App, ctx: MarkdownPostProcessorContext, el: HTMLElement, kind: BlockKind, nextSource: string): Promise<void> {
  const section = ctx.getSectionInfo(el);
  if (!section) throw new Error("This TikZ block cannot be edited from the current preview context. Open the note normally and try again.");
  const file = app.vault.getFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) throw new Error("The source note is no longer available.");
  const original = section.text;
  const open = `\`\`\`${kind}`;
  const start = original.indexOf(open);
  if (start < 0) throw new Error("Could not locate the TikZ code fence in the source section.");
  const openEnd = original.indexOf("\n", start);
  if (openEnd < 0) throw new Error("Malformed TikZ code fence.");
  const close = original.indexOf("\n```", openEnd + 1);
  if (close < 0) throw new Error("Could not locate the closing TikZ fence.");
  const replacement = `${original.slice(0, openEnd + 1)}${nextSource.replace(/\r?\n$/u, "")}\n```\n${original.slice(close + 5)}`.replace(/\n\n$/u, "\n");
  await app.vault.process(file, (data) => {
    const sectionIndex = data.indexOf(original);
    if (sectionIndex < 0) throw new Error("The note changed before the edit could be applied. Please render again and retry.");
    return `${data.slice(0, sectionIndex)}${replacement}${data.slice(sectionIndex + original.length)}`;
  });
}
