import { App, MarkdownPostProcessorContext, MarkdownSectionInformation, Notice, TFile } from "obsidian";
import { createHash } from "node:crypto";
import { BlockKind } from "../core/types";
import { RenderService } from "../core/render-service";
import { ExportService } from "../core/export-service";
import { TikzHistoryStore } from "../core/history";
import { TikzRendererView } from "../ui/renderer-view";
import { TikzSettings } from "../settings/settings";

const GENERATED_ASSET_CLASS = "tikz-generated-asset-link";
const GENERATED_EDIT_CLASS = "tikz-generated-edit-link";

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
      if (section) await ensureSourceAssetLinks(app, ctx.sourcePath, section, result.assetPath, historyKey);
      const view = new TikzRendererView(app, exportService, host, result, source, ctx.sourcePath, service, kind, history, historyKey, async (nextSource) => {
        await replaceSource(app, ctx, el, kind, nextSource);
      }, getSettings, saveSettings);
      ctx.addChild(view);
      view.render();
      scheduleGeneratedLinks(el, result.assetPath, historyKey, async () => {
        await replaceSource(app, ctx, el, kind, source);
      });
    } catch (error) {
      if (!el.isConnected) return;
      host.empty();
      const card = host.createDiv({ cls: "tikz-renderer-error" });
      card.createEl("strong", { text: "TeX/TikZ rendering failed" });
      card.createEl("pre", { text: error instanceof Error ? error.message : String(error) });
    }
  }
}

function scheduleGeneratedLinks(el: HTMLElement, assetPath: string, historyKey: string, edit: () => Promise<void>): void {
  if (!assetPath) return;
  const mark = (): void => {
    if (el.isConnected) markGeneratedLinks(el, assetPath, historyKey, edit);
  };
  window.setTimeout(mark, 0);
  window.requestAnimationFrame(mark);
}

function markGeneratedLinks(el: HTMLElement, assetPath: string, historyKey: string, edit: () => Promise<void>): void {
  const normalizedPath = assetPath.replace(/\\/gu, "/");
  const root = el.parentElement ?? el;
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.internal-link, a[href]"));
  const generated = links.find((link) => {
    const href = decodeURIComponent(link.getAttribute("href") ?? "").replace(/\\/gu, "/");
    return href === normalizedPath || href.endsWith(`/${normalizedPath}`);
  });
  if (generated) generated.classList.add(GENERATED_ASSET_CLASS);

  const candidate = links.find((link) => link.getAttribute("href") === `#tikz-edit:${historyKey}`);
  if (!candidate || candidate.classList.contains(GENERATED_EDIT_CLASS)) return;
  candidate.classList.add(GENERATED_EDIT_CLASS);
  candidate.setAttribute("data-tikz-edit", historyKey);
  candidate.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try { await edit(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
  });
}

async function ensureSourceAssetLinks(app: App, sourcePath: string, section: MarkdownSectionInformation, assetPath: string, historyKey: string): Promise<void> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!(file instanceof TFile) || !assetPath) return;
  const wikilink = `[[${assetPath}]]`;
  const editLink = `[✎ Edit TikZ](#tikz-edit:${historyKey})`;
  await app.vault.process(file, (data) => {
    const insertionOffset = findNthLineOffset(data, section.lineEnd + 1);
    const before = data.slice(Math.max(0, insertionOffset - 1000), insertionOffset);
    const after = data.slice(insertionOffset, Math.min(data.length, insertionOffset + 1000));
    const hasAsset = before.includes(wikilink) || after.startsWith(wikilink);
    const hasEdit = before.includes(editLink) || after.startsWith(editLink);
    if (hasAsset && hasEdit) return data;
    const eol = data.includes("\r\n") ? "\r\n" : "\n";
    const additions = `${hasAsset ? "" : wikilink + eol}${hasEdit ? "" : editLink + eol}`;
    return `${data.slice(0, insertionOffset)}${additions}${data.slice(insertionOffset)}`;
  });
}

function makeHistoryKey(ctx: MarkdownPostProcessorContext, section: MarkdownSectionInformation | null, kind: BlockKind, source: string): string {
  const location = section ? `${section.lineStart}` : createHash("sha256").update(source).digest("hex").slice(0, 16);
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
    return `${data.slice(0, sectionStart)}${replacement.replace(/\n/gu, eol)}${data.slice(sectionEnd)}`;
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
