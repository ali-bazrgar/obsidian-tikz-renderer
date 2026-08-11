import { App, Plugin, WorkspaceLeaf } from "obsidian";
import { TikzSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { RenderService } from "./core/render-service";
import { ExportService } from "./core/export-service";
import { TikzHistoryStore } from "./core/history";
import { TikzCodeBlockProcessor } from "./markdown/code-block";
import { TikzSettingTab } from "./settings/settings-tab";
import { TikzRendererView } from "./ui/renderer-view";
import { normalizePath } from "obsidian";

const SETTINGS_MIGRATION_VERSION = 4;

export default class TikzRendererPlugin extends Plugin {
  settings!: TikzSettings;
  private renderService!: RenderService;
  private exportService!: ExportService;
  private history!: TikzHistoryStore;
  private processor!: TikzCodeBlockProcessor;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.renderService = new RenderService(this.settings);
    this.exportService = new ExportService(this.app, this.settings);
    this.history = new TikzHistoryStore(this.app, this.settings);
    this.processor = new TikzCodeBlockProcessor(this.app, this.renderService, this.exportService, this.history, () => this.settings, async settings => this.saveSettings(settings));
    this.registerMarkdownCodeBlockProcessor("tikz", async (source, el, ctx) => this.processor.process(source, el, ctx));
    this.addSettingTab(new TikzSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.markGeneratedLinks()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.markGeneratedLinks()));
    this.registerInterval(window.setInterval(() => this.markGeneratedLinks(), 1000));
    this.markGeneratedLinks();
  }

  async onunload(): Promise<void> {
    this.renderService?.dispose();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<TikzSettings> & { __settingsMigrationVersion?: number } | null;
    const merged = Object.assign({}, DEFAULT_SETTINGS, raw ?? {}) as TikzSettings & { __settingsMigrationVersion?: number };
    const migrationVersion = raw?.__settingsMigrationVersion ?? 0;
    let changed = false;
    if (migrationVersion < SETTINGS_MIGRATION_VERSION) {
      merged.engine = DEFAULT_SETTINGS.engine;
      merged.latexPath = DEFAULT_SETTINGS.latexPath;
      merged.pdflatexPath = DEFAULT_SETTINGS.pdflatexPath;
      merged.xelatexPath = DEFAULT_SETTINGS.xelatexPath;
      merged.lualatexPath = DEFAULT_SETTINGS.lualatexPath;
      merged.dvilualatexPath = DEFAULT_SETTINGS.dvilualatexPath;
      merged.dvisvgmPath = DEFAULT_SETTINGS.dvisvgmPath;
      merged.mutoolPath = DEFAULT_SETTINGS.mutoolPath;
      merged.texLiveRoot = DEFAULT_SETTINGS.texLiveRoot;
      merged.cacheFolder = DEFAULT_SETTINGS.cacheFolder;
      merged.compileTimeout = DEFAULT_SETTINGS.compileTimeout;
      merged.preamble = DEFAULT_SETTINGS.preamble;
      merged.__settingsMigrationVersion = SETTINGS_MIGRATION_VERSION;
      changed = true;
      await this.purgeLegacyCache();
    }

    this.settings = merged;
    if (changed || migrationVersion !== SETTINGS_MIGRATION_VERSION) await this.saveData(this.settings);
  }

  private async purgeLegacyCache(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof (adapter as unknown as { getBasePath?: () => string }).getBasePath !== "function") return;
    const basePath = (adapter as unknown as { getBasePath: () => string }).getBasePath();
    const cachePath = normalizePath(`${basePath}/${normalizePath(DEFAULT_SETTINGS.cacheFolder)}`);
    try {
      const fs = await import("node:fs/promises");
      await fs.rm(cachePath, { recursive: true, force: true });
    } catch {
      // Cache cleanup must never prevent the plugin from loading.
    }
  }

  async saveSettings(settings?: TikzSettings): Promise<void> {
    if (settings) this.settings = settings;
    await this.saveData(this.settings);
    this.syncRenderedTheme();
  }

  private syncRenderedTheme(): void {
    // Existing renderer instances receive theme changes through their persisted settings state.
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view as unknown as { containerEl?: HTMLElement };
      if (view.containerEl) {
        // Trigger a lightweight DOM refresh by reloading the active markdown view when possible.
        view.containerEl.querySelectorAll<HTMLElement>(".tikz-renderer-shell").forEach(shell => {
          shell.dataset.theme = this.settings.displayTheme;
        });
      }
    });
  }

  private markGeneratedLinks(): void {
    const workspace = this.app.workspace;
    workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const root = leaf.view.containerEl;
      if (!root) return;
      root.querySelectorAll<HTMLAnchorElement>("a").forEach(link => {
        const href = link.getAttribute("href") ?? "";
        const text = link.textContent?.trim() ?? "";
        const isGenerated = href.includes("TikZ Assets/") || text.startsWith("TikZ Assets/");
        if (isGenerated) {
          link.dataset.tikzGenerated = "true";
          link.classList.add("tikz-generated-asset-link");
        }
      });
    });
  }
}
