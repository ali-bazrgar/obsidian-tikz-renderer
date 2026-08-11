import { App, normalizePath, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { RenderService } from "./core/render-service";
import { DEFAULT_SETTINGS, TikzSettings } from "./settings/settings";
import { BlockKind } from "./core/types";
import { TikzMarkdownProcessor } from "./markdown/code-block";
import { texLiveExecutableCandidates } from "./core/executable-detector";
import { createTikzLivePreviewExtensions } from "./editor/live-preview";

const LANGUAGES: BlockKind[] = ["tikz", "pgfplots", "circuitikz", "tex", "latex"];

export default class TikzRendererPlugin extends Plugin {
  settings!: TikzSettings;
  renderService!: RenderService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.renderService = new RenderService(this.app, () => this.settings);

    // The StateField owns block decorations. TeX compilation starts only from
    // the widget's DOM lifecycle, so editor transactions never await TeX.
    this.registerEditorExtension(createTikzLivePreviewExtensions(this.renderService));

    for (const language of LANGUAGES) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) =>
        TikzMarkdownProcessor.process(language, source, el, ctx, this.renderService),
      );
    }

    this.addCommand({ id: "test-tex-installation", name: "Test TeX installation", callback: async () => {
      const result = await this.renderService.testInstallation();
      new Notice(result.summary, 8000);
      console.info("[TikZ Renderer] installation test", result);
    }});

    this.addCommand({ id: "detect-tex-executables", name: "Detect TeX Live executables", callback: async () => {
      await this.detectTeXExecutables();
    }});

    this.addCommand({ id: "clear-render-cache", name: "Clear TikZ render cache", callback: async () => {
      await this.renderService.clearCache();
      new Notice("TikZ render cache cleared.");
    }});

    this.addSettingTab(new TikzSettingTab(this.app, this));
  }

  onunload(): void { this.renderService?.dispose(); }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(settings?: TikzSettings): Promise<void> {
    if (settings) this.settings = settings;
    await this.saveData(this.settings);
  }

  async detectTeXExecutables(): Promise<void> {
    const rootCandidates = texLiveExecutableCandidates(this.settings.texLiveRoot);
    const current = this.settings;
    const keys: Array<[keyof TikzSettings, keyof typeof rootCandidates]> = [
      ["latexPath", "latex"], ["pdflatexPath", "pdflatex"], ["xelatexPath", "xelatex"],
      ["lualatexPath", "lualatex"], ["dvilualatexPath", "dvilualatex"], ["dvisvgmPath", "dvisvgm"], ["mutoolPath", "mutool"],
    ];
    const detected = { ...current };
    for (const [setting, name] of keys) {
      const candidate = rootCandidates[name];
      if (candidate) (detected as Record<string, unknown>)[setting] = candidate;
    }
    const fallback = await this.renderService.detectExecutables();
    await this.saveSettings({ ...detected, ...fallback });
    new Notice("TeX executable detection complete.");
  }
}

class TikzSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TikzRendererPlugin) { super(app, plugin); }

  display(): void {
    const container = this.containerEl;
    container.empty();
    container.createEl("h2", { text: "TikZ Renderer" });

    new Setting(container).setName("Engine").addDropdown((dropdown) => dropdown
      .addOptions({ auto: "Auto", latex: "latex", pdflatex: "pdflatex", xelatex: "xelatex", lualatex: "lualatex", dvilualatex: "dvilualatex" })
      .setValue(this.plugin.settings.engine)
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, engine: value as TikzSettings["engine"] })));

    new Setting(container).setName("TeX Live root")
      .setDesc("Optional root directory, e.g. C:\\texlive\\2025")
      .addText((text) => text.setPlaceholder("C:\\texlive\\2025").setValue(this.plugin.settings.texLiveRoot)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, texLiveRoot: value.trim() })));

    new Setting(container).setName("Detect TeX Live executables")
      .setDesc("Build executable paths from the TeX Live root, then verify PATH fallbacks.")
      .addButton((button) => button.setButtonText("Detect").onClick(async () => this.plugin.detectTeXExecutables()));

    const paths: Array<[keyof TikzSettings, string]> = [
      ["latexPath", "latex path"], ["pdflatexPath", "pdflatex path"], ["xelatexPath", "xelatex path"],
      ["lualatexPath", "lualatex path"], ["dvilualatexPath", "dvilualatex path"], ["dvisvgmPath", "dvisvgm path"], ["mutoolPath", "mutool path"],
    ];
    for (const [key, name] of paths) new Setting(container).setName(name).addText((text) => text
      .setValue(String(this.plugin.settings[key]))
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, [key]: value.trim() })));

    new Setting(container).setName("Asset folder").addText((text) => text.setValue(this.plugin.settings.assetFolder)
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, assetFolder: normalizePath(value.trim()) })));
    new Setting(container).setName("Cache folder").addText((text) => text.setValue(this.plugin.settings.cacheFolder)
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, cacheFolder: normalizePath(value.trim()) })));
    new Setting(container).setName("Compile timeout (ms)").addText((text) => text.setValue(String(this.plugin.settings.compileTimeout))
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, compileTimeout: Math.max(5000, Math.min(120000, Number(value) || 30000)) })));
    new Setting(container).setName("Default zoom").addSlider((slider) => slider.setLimits(25, 500, 25).setValue(this.plugin.settings.defaultZoom).setDynamicTooltip()
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, defaultZoom: value })));
    new Setting(container).setName("Display theme").addDropdown((dropdown) => dropdown
      .addOptions({ auto: "Auto", obsidian: "Obsidian", light: "Light", paper: "Paper", dark: "Dark", contrast: "Contrast", bw: "Black & White" })
      .setValue(this.plugin.settings.displayTheme)
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, displayTheme: value as TikzSettings["displayTheme"] })));
    new Setting(container).setName("Keep TeX source").addToggle((toggle) => toggle.setValue(this.plugin.settings.keepTexSource)
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, keepTexSource: value })));
    new Setting(container).setName("Persian font").addText((text) => text.setValue(this.plugin.settings.persianFont)
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, persianFont: value.trim() })));
    new Setting(container).setName("History limit").addSlider((slider) => slider.setLimits(1, 100, 1).setValue(this.plugin.settings.historyLimit).setDynamicTooltip()
      .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, historyLimit: value })));
    new Setting(container).setName("Preamble").addTextArea((text) => {
      text.setValue(this.plugin.settings.preamble).onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, preamble: value }));
      text.inputEl.rows = 18; text.inputEl.cols = 80;
    });
  }
}
