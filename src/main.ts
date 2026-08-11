import { normalizePath, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { RenderService } from "./core/render-service";
import { ExportService } from "./core/export-service";
import { TikzHistoryStore } from "./core/history";
import { DEFAULT_SETTINGS, TikzSettings } from "./settings/settings";
import { BlockKind } from "./core/types";
import { TikzMarkdownProcessor } from "./markdown/code-block";
import { texLiveExecutableCandidates, ExecutableProbe, probeAllExecutables, TeXExecutableName } from "./core/executable-detector";
import { createTikzLivePreviewExtensions } from "./editor/live-preview";
import { TikzRendererView } from "./ui/renderer-view";

const LANGUAGES: BlockKind[] = ["tikz", "pgfplots", "circuitikz", "tex", "latex"];

export default class TikzRendererPlugin extends Plugin {
  settings!: TikzSettings;
  renderService!: RenderService;
  exportService!: ExportService;
  historyStore!: TikzHistoryStore;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.renderService = new RenderService(this.app, () => this.settings);
    this.exportService = new ExportService(this.app, () => this.settings.assetFolder);
    this.historyStore = new TikzHistoryStore(this.app, () => this.settings.historyLimit);
    this.registerEditorExtension(createTikzLivePreviewExtensions(this.renderService));

    for (const language of LANGUAGES) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) =>
        TikzMarkdownProcessor.process(this.app, this.exportService, this.historyStore, language, source, el, ctx, this.renderService, () => this.settings, async (settings) => this.saveSettings(settings)),
      );
    }

    this.addCommand({ id: "test-tex-installation", name: "Test TeX installation", callback: async () => {
      const result = await this.renderService.testInstallation();
      new Notice(result.summary, 8000);
    }});
    this.addCommand({ id: "detect-tex-executables", name: "Detect TeX Live executables", callback: async () => this.detectTeXExecutables() });
    this.addCommand({ id: "clear-render-cache", name: "Clear TikZ render cache", callback: async () => { await this.renderService.clearCache(); new Notice("TikZ render cache cleared."); }});
    this.addSettingTab(new TikzSettingTab(this.app, this));
  }

  onunload(): void {
    TikzRendererView.disposeAll();
    this.renderService?.dispose();
  }

  async loadSettings(): Promise<void> { this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<TikzSettings>) }; }
  async saveSettings(settings?: TikzSettings): Promise<void> { if (settings) this.settings = settings; await this.saveData(this.settings); }

  async detectTeXExecutables(): Promise<ExecutableProbe[]> {
    const rootCandidates = texLiveExecutableCandidates(this.settings.texLiveRoot);
    const paths: Partial<Record<TeXExecutableName, string>> = {
      latex: rootCandidates.latex ?? this.settings.latexPath,
      pdflatex: rootCandidates.pdflatex ?? this.settings.pdflatexPath,
      xelatex: rootCandidates.xelatex ?? this.settings.xelatexPath,
      lualatex: rootCandidates.lualatex ?? this.settings.lualatexPath,
      dvilualatex: rootCandidates.dvilualatex ?? this.settings.dvilualatexPath,
      dvisvgm: rootCandidates.dvisvgm ?? this.settings.dvisvgmPath,
      mutool: rootCandidates.mutool ?? this.settings.mutoolPath,
    };
    const results = await probeAllExecutables(paths);
    const detected = { ...this.settings };
    const keys: Array<[keyof TikzSettings, TeXExecutableName]> = [["latexPath", "latex"], ["pdflatexPath", "pdflatex"], ["xelatexPath", "xelatex"], ["lualatexPath", "lualatex"], ["dvilualatexPath", "dvilualatex"], ["dvisvgmPath", "dvisvgm"], ["mutoolPath", "mutool"]];
    for (const [setting, name] of keys) {
      const result = results.find((item) => item.name === name);
      if (result?.ok) (detected as Record<string, unknown>)[setting] = result.configuredPath;
    }
    await this.saveSettings(detected);
    const summary = results.map((result) => `${result.name}: ${result.ok ? "OK" : `FAILED — ${result.error ?? "unknown error"}`}`).join("\n");
    new Notice(summary, 10000);
    return results;
  }
}

class TikzSettingTab extends PluginSettingTab {
  private detectionContainer?: HTMLElement;
  constructor(app: import("obsidian").App, private readonly plugin: TikzRendererPlugin) { super(app, plugin); }

  display(): void {
    const container = this.containerEl;
    container.empty();
    container.createEl("h2", { text: "TikZ Renderer" });
    new Setting(container).setName("Engine").addDropdown((dropdown) => dropdown.addOptions({ auto: "Auto", latex: "latex", pdflatex: "pdflatex", xelatex: "xelatex", lualatex: "lualatex", dvilualatex: "dvilualatex" }).setValue(this.plugin.settings.engine).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, engine: value as TikzSettings["engine"] })));
    new Setting(container).setName("TeX Live root").setDesc("Accepts either the installation root or its Windows binary directory.").addText((text) => text.setPlaceholder("D:\\texlive\\2025").setValue(this.plugin.settings.texLiveRoot).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, texLiveRoot: value.trim() })));
    new Setting(container).setName("Detect TeX Live executables").setDesc("Checks every configured executable with --version.").addButton((button) => button.setButtonText("Detect").onClick(async () => this.renderDetectionResults(await this.plugin.detectTeXExecutables())));
    this.detectionContainer = container.createDiv({ cls: "tikz-detection-results" });
    this.renderDetectionResults([]);

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

  private renderDetectionResults(results: ExecutableProbe[]): void {
    const container = this.detectionContainer;
    if (!container) return;
    container.empty();
    for (const result of results) {
      const row = container.createDiv({ cls: result.ok ? "tikz-detection-ok" : "tikz-detection-failed" });
      row.createSpan({ text: `${result.ok ? "✓" : "✗"} ${result.name}: ${result.ok ? "OK" : "FAILED"}` });
      row.createEl("small", { text: result.ok ? `${result.configuredPath}${result.version ? ` — ${result.version}` : ""}` : (result.error ?? "Unknown error") });
    }
  }
}
