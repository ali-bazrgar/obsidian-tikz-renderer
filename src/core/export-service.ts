import { App, normalizePath, Notice } from "obsidian";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export class ExportService {
  constructor(private readonly app: App, private readonly getAssetFolder: () => string) {}

  async saveSvg(svg: string, hash: string, sourcePath?: string): Promise<string> {
    const folder = this.resolveAssetFolder(sourcePath);
    await this.ensureVaultFolder(folder);
    const file = this.uniqueName(folder, `${hash}.svg`);
    await this.app.vault.adapter.write(file, svg);
    new Notice(`TikZ SVG saved: ${file}`);
    return file;
  }

  async savePng(svg: string, hash: string, sourcePath?: string): Promise<string> {
    const folder = this.resolveAssetFolder(sourcePath);
    await this.ensureVaultFolder(folder);
    const relativePng = normalizePath(`${folder}/${hash}.png`);
    const png = await svgToPng(svg, 2);
    await this.app.vault.adapter.writeBinary(relativePng, png);
    new Notice(`TikZ PNG saved: ${relativePng}`);
    return relativePng;
  }

  private resolveAssetFolder(sourcePath?: string): string {
    const configured = normalizePath(this.getAssetFolder().trim() || "TikZ Assets").replace(/^\/+|\/+$/gu, "");
    if (!sourcePath) return configured;
    const parent = normalizePath(path.posix.dirname(sourcePath));
    return parent === "." ? configured : normalizePath(`${parent}/${configured}`);
  }

  private async ensureVaultFolder(folder: string): Promise<void> {
    const parts = folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current)) await this.app.vault.createFolder(current);
    }
  }

  private uniqueName(folder: string, filename: string): string { return normalizePath(`${folder}/${filename}`); }
}

async function svgToPng(svg: string, scale: number): Promise<ArrayBuffer> {
  if (typeof document === "undefined" || typeof Image === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    throw new Error("PNG export is only available in the Obsidian Desktop renderer environment.");
  }
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("The generated SVG could not be rasterized for PNG export."));
      img.src = url;
    });
    const intrinsicWidth = image.naturalWidth || parseSvgDimension(svg, "width") || 800;
    const intrinsicHeight = image.naturalHeight || parseSvgDimension(svg, "height") || 600;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(8192, Math.ceil(intrinsicWidth * scale)));
    canvas.height = Math.max(1, Math.min(8192, Math.ceil(intrinsicHeight * scale)));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable for PNG export.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Canvas PNG encoding failed.")), "image/png"));
    return await pngBlob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseSvgDimension(svg: string, name: "width" | "height"): number | undefined {
  const match = new RegExp(`\\b${name}=["']([0-9.]+)`, "u").exec(svg);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
