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
      if (section) await ensureSourceAssetLinks(app, ctx.sourcePath, section, result.assetPath, historyKey, kind);
      const edit = async (): Promise<void> => replaceSource(app, ctx, el, kind, source);
      const view = new TikzRendererView(app, exportService, host, result, source, ctx.sourcePath, service, kind, history, historyKey, async nextSource => replaceSource(app, ctx, el, kind, nextSource), getSettings, saveSettings);
      ctx.addChild(view);
      view.render();
      scheduleGeneratedLinks(el, result.assetPath, historyKey, edit);
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
  const mark = (): void => { if (el.isConnected) markGeneratedLinks(el, assetPath, historyKey, edit); };
  window.setTimeout(mark, 0);
  window.requestAnimationFrame(mark);
  window.setTimeout(mark, 50);
  window.setTimeout(mark, 250);
  window.setTimeout(mark, 1000);
}

function markGeneratedLinks(el: HTMLElement, assetPath: string, historyKey: string, edit: () => Promise<void>): void {
  const normalizedPath = assetPath.replace(/\\/gu, "/");
  const roots: Element[] = [document.body];
  if (el.parentElement) roots.push(el.parentElement);
  const section = el.closest(".markdown-preview-section, .markdown-source-view, .cm-content");
  if (section) roots.push(section);
  const links = Array.from(new Set(roots.flatMap(root => Array.from(root.querySelectorAll<HTMLAnchorElement>("a.internal-link, a[href]")))));
  for (const link of links) {
    const href = decodeURIComponent(link.getAttribute("href") ?? "").replace(/\\/gu, "/");
    const text = link.textContent?.trim().replace(/\\/gu, "/") ?? "";
    if (href === normalizedPath || href.endsWith(`/${normalizedPath}`) || text === normalizedPath || text.endsWith(`/${normalizedPath}`)) {
      link.classList.add(GENERATED_ASSET_CLASS);
      link.dataset.tikzGenerated = historyKey;
    }
    if (href === `#tikz-edit:${historyKey}` || text === "✎ Edit TikZ") {
      link.classList.add(GENERATED_EDIT_CLASS);
      link.dataset.tikzEdit = historyKey;
      if (link.dataset.tikzBound !== "true") {
        link.dataset.tikzBound = "true";
        link.addEventListener("click", async event => {
          event.preventDefault();
          event.stopPropagation();
          try { await edit(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
        });
      }
    }
  }
}

async function ensureSourceAssetLinks(app: App, sourcePath: string, section: MarkdownSectionInformation, assetPath: string, historyKey: string, kind: BlockKind): Promise<void> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!(file instanceof TFile) || !assetPath) return;
  const wikilink = `[[${assetPath}]]`;
  await app.vault.process(file, data => {
    const eol = data.includes("\r\n") ? "\r\n" : "\n";
    const lines = data.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const trimmed = lines[index].trim();
      if (trimmed === wikilink || /\[✎\s*Edit TikZ\]\(\s*#tikz-edit\\?:/u.test(trimmed)) lines.splice(index, 1);
    }
    const startLine = Math.max(0, Math.min(section.lineStart, lines.length - 1));
    let open = -1;
    for (let i = startLine; i < lines.length; i += 1) {
      if (lines[i].trimEnd() === `\`\`\`${kind}`) { open = i; break; }
      if (i > startLine + 4 && lines[i].trim() !== "") break;
    }
    if (open < 0) return data;
    let close = -1;
    for (let i = open + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "```") { close = i; break; }
    }
    if (close < 0) return data;
    lines.splice(close + 1, 0, wikilink);
    return lines.join(eol);
  });
}

function makeHistoryKey(ctx: MarkdownPostProcessorContext, section: MarkdownSectionInformation | null, kind: BlockKind, source: string): string {
  const canonicalSource = source.replace(/\r\n/gu, "\n").replace(/[ \t]+$/gmu, "").trimEnd();
  const sourceHash = createHash("sha256").update(canonicalSource).digest("hex").slice(0, 32);
  const blockAnchor = section ? String(section.lineStart) : "unknown";
  return `${ctx.sourcePath}:${kind}:${blockAnchor}:${sourceHash}`;
}

async function replaceSource(app: App, ctx: MarkdownPostProcessorContext, el: HTMLElement, kind: BlockKind, nextSource: string): Promise<void> {
  const section = ctx.getSectionInfo(el);
  if (!section) throw new Error("This TikZ block cannot be edited from the current preview context. Open the note normally and try again.");
  const file = app.vault.getFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) throw new Error("The source note is no longer available.");
  const originalLines = section.text.split(/\r?\n/u);
  const openIndex = originalLines.findIndex(line => line.trimEnd() === `\`\`\`${kind}`);
  if (openIndex < 0) throw new Error("Could not locate the TikZ code fence in the source section.");
  let closeIndex = -1;
  for (let index = openIndex + 1; index < originalLines.length; index += 1) if (originalLines[index].trim() === "```") { closeIndex = index; break; }
  if (closeIndex < 0) throw new Error("Could not locate the closing TikZ fence.");
  const normalizedSource = nextSource.replace(/\r?\n$/u, "");
  const replacement = [...originalLines.slice(0, openIndex + 1), ...normalizedSource.split(/\r?\n/u), "```", ...originalLines.slice(closeIndex + 1)].join("\n");
  await app.vault.process(file, data => {
    const sectionStart = findNthLineOffset(data, section.lineStart);
    const sectionEnd = findNthLineOffset(data, section.lineEnd);
    const currentSection = data.slice(sectionStart, sectionEnd).replace(/\r\n/gu, "\n");
    const expected = section.text.replace(/\r\n/gu, "\n");
    if (currentSection !== expected && !currentSection.startsWith(expected)) throw new Error("The note changed before the edit could be applied. Please render again and retry.");
    const eol = data.includes("\r\n") ? "\r\n" : "\n";
    return `${data.slice(0, sectionStart)}${replacement.replace(/\n/gu, eol)}${data.slice(sectionEnd)}`;
  });
}

function findNthLineOffset(text: string, lineNumber: number): number { if (lineNumber <= 0) return 0; let offset = 0; for (let line = 0; line < lineNumber; line += 1) { const next = text.indexOf("\n", offset); if (next < 0) return text.length; offset = next + 1; } return offset; }
