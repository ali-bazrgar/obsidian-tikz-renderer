import { App, normalizePath, Notice } from "obsidian";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ExportService {
  constructor(private readonly app: App, private readonly getAssetFolder: () => string, private readonly getMutoolPath: () => string) {}

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
    const relativeSvg = `${folder}/${hash}.svg`;
    const relativePng = `${folder}/${hash}.png`;
    await this.app.vault.adapter.write(relativeSvg, svg);

    const tempRoot = path.join(this.app.vault.adapter.getBasePath(), ".tikz-cache", `export-${hash}-${Date.now()}`);
    await fs.mkdir(tempRoot, { recursive: true });
    const input = path.join(tempRoot, `${hash}.svg`);
    const output = path.join(tempRoot, `${hash}.png`);
    try {
      await fs.writeFile(input, svg, "utf8");
      await execFileAsync(this.getMutoolPath(), ["draw", "-r", "192", "-o", output, input], {
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      }).catch(async () => {
        throw new Error("PNG export requires a mutool build capable of rasterizing the generated SVG/PDF. Configure mutool in Settings.");
      });
      await this.app.vault.adapter.write(relativePng, await fs.readFile(output));
      new Notice(`TikZ PNG saved: ${relativePng}`);
      return relativePng;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
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

  private uniqueName(folder: string, filename: string): string {
    return normalizePath(`${folder}/${filename}`);
  }
}
