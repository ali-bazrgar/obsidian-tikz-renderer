import { App, Notice, normalizePath } from "obsidian";
import * as path from "node:path";

export class ExportService {
  constructor(private readonly app: App, private readonly getAssetFolder: () => string) {}

  async saveSvg(svg: string, hash: string, sourcePath?: string, notify = true): Promise<string> {
    const folder = this.resolveAssetFolder(sourcePath);
    await this.ensureVaultFolder(folder);
    const file = normalizePath(`${folder}/${hash}.svg`);
    await this.app.vault.adapter.write(file, svg);
    if (notify) new Notice(`TikZ SVG saved: ${file}`);
    return file;
  }

  async savePng(svg: string, hash: string, sourcePath?: string): Promise<string> {
    const folder = normalizePath(`${this.resolveAssetFolder(sourcePath)}/PNG`);
    await this.ensureVaultFolder(folder);
    const relativePng = await this.nextPngPath(folder, hash);
    const png = await svgToPng(svg, 1);
    await this.app.vault.adapter.writeBinary(relativePng, png);
    new Notice(`TikZ PNG saved: ${relativePng}`);
    return relativePng;
  }

  async savePngSnapshot(svg: string, hash: string, sourcePath: string, viewportWidth: number, viewportHeight: number, zoom: number, panX: number, panY: number, backgroundColor: string): Promise<string> {
    const folder = normalizePath(`${this.resolveAssetFolder(sourcePath)}/PNG`);
    await this.ensureVaultFolder(folder);
    const relativePng = await this.nextPngPath(folder, hash);
    const png = await svgToPngSnapshot(svg, 1, viewportWidth, viewportHeight, zoom, panX, panY, backgroundColor);
    await this.app.vault.adapter.writeBinary(relativePng, png);
    new Notice(`TikZ PNG saved: ${relativePng}`);
    return relativePng;
  }

  private async nextPngPath(folder: string, hash: string): Promise<string> {
    const base = normalizePath(`${folder}/${hash}`);
    let index = 1;
    let candidate = normalizePath(`${base}.png`);
    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = normalizePath(`${base}-${index}.png`);
      index += 1;
    }
    return candidate;
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
}

async function svgToPng(svg: string, scale: number): Promise<ArrayBuffer> {
  if (typeof document === "undefined" || typeof Image === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    throw new Error("PNG export is only available in the Obsidian Desktop renderer environment.");
  }
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadSvgImage(url);
    const intrinsicWidth = getSvgWidth(svg, image);
    const intrinsicHeight = getSvgHeight(svg, image);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(8192, Math.ceil(intrinsicWidth * scale)));
    canvas.height = Math.max(1, Math.min(8192, Math.ceil(intrinsicHeight * scale)));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable for PNG export.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasToPng(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function svgToPngSnapshot(svg: string, scale: number, viewportWidth: number, viewportHeight: number, zoom: number, panX: number, panY: number, backgroundColor: string): Promise<ArrayBuffer> {
  if (typeof document === "undefined" || typeof Image === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    throw new Error("PNG export is only available in the Obsidian Desktop renderer environment.");
  }
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadSvgImage(url);
    // The renderer's live geometry is based on SVG viewBox dimensions first.
    // Use the same source of truth here so the rasterized pixels use exactly
    // the same coordinate system as the on-screen SVG.
    const intrinsicWidth = getSvgWidth(svg, image);
    const intrinsicHeight = getSvgHeight(svg, image);
    const width = Math.max(1, Math.min(8192, Math.ceil(viewportWidth * scale)));
    const height = Math.max(1, Math.min(8192, Math.ceil(viewportHeight * scale)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable for PNG export.");
    if (backgroundColor && backgroundColor !== "transparent") {
      context.fillStyle = backgroundColor;
      context.fillRect(0, 0, width, height);
    }
    const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const safePanX = Number.isFinite(panX) ? panX : 0;
    const safePanY = Number.isFinite(panY) ? panY : 0;
    context.drawImage(image, safePanX * scale, safePanY * scale, intrinsicWidth * safeZoom * scale, intrinsicHeight * safeZoom * scale);
    return await canvasToPng(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadSvgImage(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The generated SVG could not be rasterized for PNG export."));
    image.src = url;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    canvas.toBlob(async (value) => {
      if (!value) {
        reject(new Error("Canvas PNG encoding failed."));
        return;
      }
      resolve(await value.arrayBuffer());
    }, "image/png");
  });
}

function getSvgWidth(svg: string, image: HTMLImageElement): number {
  const viewBox = parseSvgViewBox(svg);
  return viewBox?.width || image.naturalWidth || parseSvgDimension(svg, "width") || 800;
}

function getSvgHeight(svg: string, image: HTMLImageElement): number {
  const viewBox = parseSvgViewBox(svg);
  return viewBox?.height || image.naturalHeight || parseSvgDimension(svg, "height") || 600;
}

function parseSvgViewBox(svg: string): { width: number; height: number } | undefined {
  const match = /\bviewBox=["']\s*[-+0-9.eE]+\s+[-+0-9.eE]+\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s*["']/u.exec(svg);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : undefined;
}

function parseSvgDimension(svg: string, name: "width" | "height"): number | undefined {
  const match = new RegExp(`\\b${name}=["']([0-9.]+)`, "u").exec(svg);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
