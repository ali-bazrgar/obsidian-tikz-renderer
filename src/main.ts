import { normalizePath, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { RenderService } from "./core/render-service";
import { ExportService } from "./core/export-service";
import { TikzHistoryStore } from "./core/history";
import { DEFAULT_SETTINGS, TikzSettings } from "./settings/settings";
import { BlockKind } from "./core/types";
import { TikzMarkdownProcessor } from "./markdown/code-block";
import { texLiveExecutableCandidates, ExecutableProbe, probeAllExecutables, TeXExecutableName } from "./core/executable-detector";
import { TikzRendererView } from "./ui/renderer-view";

const LANGUAGES: BlockKind[] = ["tikz", "pgfplots", "circuitikz", "tex", "latex"];
const GENERATED_ASSET_CLASS = "tikz-generated-asset-link";
const GENERATED_EDIT_CLASS = "tikz-generated-edit-link";
const SETTINGS_MIGRATION_VERSION = 4;

export default class TikzRendererPlugin extends Plugin {
  settings!: TikzSettings;
  renderService!: RenderService;
  exportService!: ExportService;
  historyStore!: TikzHistoryStore;
  private generatedLinkObserver?: MutationObserver;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.renderService = new RenderService(this.app, () => this.settings);
    this.exportService = new ExportService(this.app, () => this.settings.assetFolder);
    this.historyStore = new TikzHistoryStore(this.app, () => this.settings.historyLimit);
    for (const language of LANGUAGES) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) =>
        TikzMarkdownProcessor.process(this.app, this.exportService, this.historyStore, language, source, el, ctx, this.renderService, () => this.settings, async (settings) => this.saveSettings(settings)),
      );
    }
    this.generatedLinkObserver = new MutationObserver(() => this.markGeneratedLinks());
    this.generatedLinkObserver.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.generatedLinkObserver?.disconnect());
    this.markGeneratedLinks();
    this.addCommand({ id: "test-tex-installation", name: "Test TeX installation", callback: async () => { const result = await this.renderService.testInstallation(); new Notice(result.summary, 8000); }});
    this.addCommand({ id: "detect-tex-executables", name: "Detect TeX Live executables", callback: async () => this.detectTeXExecutables() });
    this.addCommand({ id: "clear-render-cache", name: "Clear TikZ render cache", callback: async () => { await this.renderService.clearCache(); new Notice("TikZ render cache cleared."); }});
    this.addSettingTab(new TikzSettingTab(this.app, this));
    this.syncRenderedTheme();
  }

  private markGeneratedLinks(): void {
    const anchors = Array.from(document.body.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const link of anchors) {
      const href = decodeURIComponent(link.getAttribute("href") ?? "").replace(/\\/gu, "/");
      const text = link.textContent?.trim() ?? "";
      if (/^#tikz-edit:/u.test(href) || text === "✎ Edit TikZ") link.classList.add(GENERATED_EDIT_CLASS);
      if (link.dataset.tikzGenerated) link.classList.add(GENERATED_ASSET_CLASS);
    }
  }

  private syncRenderedTheme(): void {
    const settings = this.settings;
    const theme = settings.displayTheme === "auto" ? (document.body.classList.contains("theme-dark") ? "dark" : "light") : settings.displayTheme;
    document.querySelectorAll<HTMLElement>(".tikz-renderer-shell").forEach((shell) => {
      shell.dataset.theme = theme;
      if (theme === "custom") {
        shell.style.setProperty("--tikz-custom-bg", settings.customBackgroundColor);
        shell.style.setProperty("--tikz-custom-bg-opacity", `${settings.customBackgroundOpacity / 100}`);
      } else {
        shell.style.removeProperty("--tikz-custom-bg");
        shell.style.removeProperty("--tikz-custom-bg-opacity");
      }
    });
  }

  onunload(): void {
    this.generatedLinkObserver?.disconnect();
    this.generatedLinkObserver = undefined;
    TikzRendererView.disposeAll();
    this.renderService?.dispose();
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as (Partial<TikzSettings> & { __settingsMigrationVersion?: number }) | null;
    const merged = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    const migrationVersion = saved?.__settingsMigrationVersion ?? 0;
    let changed = false;

    if (isLegacyHeavyDefaultPreamble(merged.preamble)) {
      merged.preamble = DEFAULT_SETTINGS.preamble;
      changed = true;
    }

    if (migrationVersion < SETTINGS_MIGRATION_VERSION) {
      // Remove stale compiler/preamble state from the pre-resolver pipeline.
      // UI preferences and the user's asset/history locations are preserved.
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
      (merged as TikzSettings & { __settingsMigrationVersion?: number }).__settingsMigrationVersion = SETTINGS_MIGRATION_VERSION;
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
    const cachePath = pathJoin(basePath, normalizePath(DEFAULT_SETTINGS.cacheFolder));
    try {
      const fs = await import("node:fs/promises");
      await fs.rm(cachePath, { recursive: true, force: true });
    } catch {
      // Cache cleanup must never prevent the plugin from loading.
    }
  }

  async saveSettings(settings?: TikzSettings): Promise<void> { if (settings) this.settings = settings; await this.saveData(this.settings); this.syncRenderedTheme(); }

  async detectTeXExecutables(): Promise<ExecutableProbe[]> {
    const rootCandidates = texLiveExecutableCandidates(this.settings.texLiveRoot);
    const paths: Partial<Record<TeXExecutableName, string>> = { latex: rootCandidates.latex ?? this.settings.latexPath, pdflatex: rootCandidates.pdflatex ?? this.settings.pdflatexPath, xelatex: rootCandidates.xelatex ?? this.settings.xelatexPath, lualatex: rootCandidates.lualatex ?? this.settings.lualatexPath, dvilualatex: rootCandidates.dvilualatex ?? this.settings.dvilualatexPath, dvisvgm: rootCandidates.dvisvgm ?? this.settings.dvisvgmPath, mutool: rootCandidates.mutool ?? this.settings.mutoolPath };
    const results = await probeAllExecutables(paths);
    const detected = { ...this.settings };
    const keys: Array<[keyof TikzSettings, TeXExecutableName]> = [["latexPath", "latex"], ["pdflatexPath", "pdflatex"], ["xelatexPath", "xelatex"], ["lualatexPath", "lualatex"], ["dvilualatexPath", "dvilualatex"], ["dvisvgmPath", "dvisvgm"], ["mutoolPath", "mutool"]];
    for (const [setting, name] of keys) { const result = results.find((item) => item.name === name); if (result?.ok) (detected as Record<string, unknown>)[setting] = result.configuredPath; }
    await this.saveSettings(detected);
    const summary = results.map((result) => `${result.name}: ${result.ok ? "OK" : `FAILED — ${result.error ?? "unknown error"}`}`).join("\n");
    new Notice(summary, 10000);
    return results;
  }
}

function isLegacyHeavyDefaultPreamble(preamble: string | undefined): boolean {
  if (!preamble) return false;
  const requiredMarkers = ["\\usepackage{pgfplots}", "\\usepackage{circuitikz}", "\\usepackage{tikz-cd}", "\\usepackage{forest}", "\\usepackage{smartdiagram}", "\\usepackage{pgf-pie}", "\\usepackage{pgfgantt}", "\\pgfplotsset{compat=1.18}", "\\usetikzlibrary{arrows,arrows.meta"];
  return requiredMarkers.every((marker) => preamble.includes(marker));
}

function pathJoin(base: string, relative: string): string {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/u, "")}${separator}${relative.replace(/^[/\\]+/u, "")}`;
}

class TikzSettingTab extends PluginSettingTab {
  private detectionContainer?: HTMLElement;
  constructor(app: import("obsidian").App, private readonly plugin: TikzRendererPlugin) { super(app, plugin); }
  display(): void {
    const container = this.containerEl; container.empty(); container.createEl("h2", { text: "TikZ Renderer" });
    new Setting(container).setName("Engine").addDropdown((dropdown) => dropdown.addOptions({ auto: "Auto", latex: "latex", pdflatex: "pdflatex", xelatex: "xelatex", lualatex: "lualatex", dvilualatex: "dvilualatex" }).setValue(this.plugin.settings.engine).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, engine: value as TikzSettings["engine"] })));
    new Setting(container).setName("TeX Live root").setDesc("Accepts either the installation root or its Windows binary directory.").addText((text) => text.setPlaceholder("D:\\texlive\\2025").setValue(this.plugin.settings.texLiveRoot).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, texLiveRoot: value.trim() })));
    new Setting(container).setName("Detect TeX Live executables").setDesc("Checks every configured executable with --version.").addButton((button) => button.setButtonText("Detect").onClick(async () => this.renderDetectionResults(await this.plugin.detectTeXExecutables())));
    this.detectionContainer = container.createDiv({ cls: "tikz-detection-results" }); this.renderDetectionResults([]);
    const paths: Array<[keyof TikzSettings, string]> = [["latexPath", "latex path"], ["pdflatexPath", "pdflatex path"], ["xelatexPath", "xelatex path"], ["lualatexPath", "lualatex path"], ["dvilualatexPath", "dvilualatex path"], ["dvisvgmPath", "dvisvgm path"], ["mutoolPath", "mutool path"]];
    for (const [key, name] of paths) new Setting(container).setName(name).addText((text) => text.setValue(String(this.plugin.settings[key])).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, [key]: value.trim() })));
    new Setting(container).setName("Asset folder").addText((text) => text.setValue(this.plugin.settings.assetFolder).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, assetFolder: normalizePath(value.trim()) })));
    new Setting(container).setName("Cache folder").addText((text) => text.setValue(this.plugin.settings.cacheFolder).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, cacheFolder: normalizePath(value.trim()) })));
    new Setting(container).setName("Compile timeout (ms)").addText((text) => text.setValue(String(this.plugin.settings.compileTimeout)).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, compileTimeout: Math.max(5000, Math.min(120000, Number(value) || 30000)) })));
    new Setting(container).setName("Default zoom").addSlider((slider) => slider.setLimits(25, 500, 25).setValue(this.plugin.settings.defaultZoom).setDynamicTooltip().onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, defaultZoom: value })));
    new Setting(container).setName("Display theme").setDesc("Changes the figure background only; TikZ source and SVG colors are never rewritten.").addDropdown((dropdown) => dropdown.addOptions({ auto: "Auto", obsidian: "Obsidian", light: "Light", paper: "Paper", dark: "Dark", contrast: "Contrast", bw: "Black & white", custom: "Custom" }).setValue(this.plugin.settings.displayTheme).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, displayTheme: value as TikzSettings["displayTheme"] })));
    new Setting(container).setName("Custom background").addColorPicker((picker) => picker.setValue(this.plugin.settings.customBackgroundColor).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, customBackgroundColor: value })));
    new Setting(container).setName("Custom background opacity").addSlider((slider) => slider.setLimits(10, 100, 1).setValue(this.plugin.settings.customBackgroundOpacity).setDynamicTooltip().onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, customBackgroundOpacity: value })));
    new Setting(container).setName("Keep TeX source").addToggle((toggle) => toggle.setValue(this.plugin.settings.keepTexSource).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, keepTexSource: value })));
    new Setting(container).setName("Persian font").addText((text) => text.setValue(this.plugin.settings.persianFont).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, persianFont: value.trim() })));
    new Setting(container).setName("History limit").addSlider((slider) => slider.setLimits(1, 100, 1).setValue(this.plugin.settings.historyLimit).setDynamicTooltip().onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, historyLimit: value })));
    new Setting(container).setName("Preamble").addTextArea((text) => { text.setValue(this.plugin.settings.preamble).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, preamble: value })); text.inputEl.rows = 18; text.inputEl.cols = 80; });
  }
  private renderDetectionResults(results: ExecutableProbe[]): void { const container = this.detectionContainer; if (!container) return; container.empty(); for (const result of results) { const row = container.createDiv({ cls: result.ok ? "tikz-detection-ok" : "tikz-detection-failed" }); row.createSpan({ text: `${result.ok ? "✓" : "✗"} ${result.name}: ${result.ok ? "OK" : "FAILED"}` }); row.createEl("small", { text: result.ok ? `${result.configuredPath}${result.version ? ` — ${result.version}` : ""}` : (result.error ?? "Unknown error") }); } }
}
