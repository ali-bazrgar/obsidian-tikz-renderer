import { App, MarkdownPostProcessorContext, MarkdownSectionInformation, TFile } from "obsidian";
import { createHash } from "node:crypto";
import { BlockKind } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { TikzRendererView } from "../ui/renderer-view";
import { TikzSettings } from "../settings/settings";

export class TikzMarkdownProcessor {
  static async process(app: App, exportService: ExportService, history: TikzHistoryStore, kind: BlockKind, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, service: RenderService, getSettings: () => TikzSettings, saveSettings: (settings: TikzSettings) => Promise<void>): Promise<void> {
    el.empty();
    const host = el.createDiv({ cls: "tikz-renderer-block" });
    host.createDiv({ cls: "tikz-renderer-status", text: "" });
    const section = ctx.getSectionInfo(el);
    const historyKey = makeHistoryKey(ctx, section, kind, source);
    history.record(historyKey, source);
    try {
      const result = await service.render(source, kind);
      if (!el.isConnected) return;
      result.assetPath = await exportService.saveSvg(result.svg, result.hash, ctx.sourcePath, false);
      new TikzRendererView(app, exportService, host, result, source, ctx.sourcePath, service, kind, history, historyKey, async (nextSource) => {
        await replaceSource(app, ctx, el, kind, nextSource);
      }, getSettings, saveSettings).render();
    } catch (error) {
      if (!el.isConnected) return;
      host.empty();
      const card = host.createDiv({ cls: "tikz-renderer-error" });
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

  const originalLines = section.text.split(/\r?\n/u);
  const openIndex = originalLines.findIndex((line) => line.trimEnd() === `\`\`\`${kind}`);
  if (openIndex < 0) throw new Error("Could not locate the TikZ code fence in the source section.");

  let closeIndex = -1;
  for (let index = openIndex + 1; index < originalLines.length; index += 1) {
    if (originalLines[index].trim() === "```") { closeIndex = index; break; }
  }
  if (closeIndex < 0) throw new Error("Could not locate the closing TikZ fence.");

  const normalizedSource = nextSource.replace(/\r?\n$/u, "");
  const replacementLines = [...originalLines.slice(0, openIndex + 1), ...normalizedSource.split(/\r?\n/u), "```", ...originalLines.slice(closeIndex + 1)];
  const replacement = replacementLines.join("\n");

  await app.vault.process(file, (data) => {
    const sectionStart = findNthLineOffset(data, section.lineStart);
    const sectionEnd = findNthLineOffset(data, section.lineEnd);
    const currentSection = data.slice(sectionStart, sectionEnd);
    if (currentSection.replace(/\r\n/gu, "\n") !== section.text.replace(/\r\n/gu, "\n")) throw new Error("The note changed before the edit could be applied. Please render again and retry.");
    const eol = data.includes("\r\n") ? "\r\n" : "\n";
    const replacementWithEol = replacement.replace(/\n/gu, eol);
    return `${data.slice(0, sectionStart)}${replacementWithEol}${data.slice(sectionEnd)}`;
  });
}

function findNthLineOffset(text: string, lineNumber: number): number {
  if (lineNumber <= 0) return 0;
  let offset = 0;
  for (let line = 0; line < lineNumber; line += 1) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}
