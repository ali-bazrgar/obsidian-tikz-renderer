import { App, normalizePath, Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import { RenderService } from "./core/render-service";
import { DEFAULT_PREAMBLE, TikzSettings } from "./settings/settings";
import { TikzMarkdownProcessor } from "./markdown/code-block";

export default class TikzRendererPlugin extends Plugin {
  settings!: TikzSettings;
  renderService!: RenderService;
  async onload(): Promise<void> {
    await this.loadSettings();
    this.renderService = new RenderService(this.app, () => this.settings);
    for (const language of ["tikz", "pgfplots", "circuitikz", "tex", "latex"]) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => TikzMarkdownProcessor.process(source, el, ctx, this.renderService));
    }
    this.addCommand({ id: "test-tex-installation", name: "Test TeX installation", callback: async () => { const r = await this.renderService.testInstallation(); new Notice(r.summary, 8000); console.info("[TikZ Renderer]", r); } });
    this.addCommand({ id: "detect-tex-executables", name: "Detect TeX Live executables", callback: async () => { await this.saveSettings({ ...this.settings, ...(await this.renderService.detectExecutables()) }); new Notice("TeX executable detection complete."); } });
    this.addCommand({ id: "clear-render-cache", name: "Clear TikZ render cache", callback: async () => { await this.renderService.clearCache(); new Notice("TikZ render cache cleared."); } });
    this.addSettingTab(new TikzSettingTab(this.app, this));
  }
  onunload(): void { this.renderService?.dispose(); }
  async loadSettings(): Promise<void> { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings(settings?: TikzSettings): Promise<void> { if (settings) this.settings = settings; await this.saveData(this.settings); }
}
export const DEFAULT_SETTINGS: TikzSettings = {
  engine: "auto", latexPath: "latex", pdflatexPath: "pdflatex", xelatexPath: "xelatex", lualatexPath: "lualatex", dvilualatexPath: "dvilualatex", dvisvgmPath: "dvisvgm", mutoolPath: "mutool",
  assetFolder: "TikZ Assets", cacheFolder: ".tikz-cache", displayTheme: "auto", defaultZoom: 100, keepTexSource: false, compileTimeout: 30000, persianFont: "Vazirmatn", preamble: DEFAULT_PREAMBLE, historyLimit: 20,
};
class TikzSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TikzRendererPlugin) { super(app, plugin); }
  display(): void {
    const c = this.containerEl; c.empty(); c.createEl("h2", { text: "TikZ Renderer" });
    new Setting(c).setName("Engine").addDropdown(d => d.addOptions({ auto:"Auto",latex:"latex",pdflatex:"pdflatex",xelatex:"xelatex",lualatex:"lualatex",dvilualatex:"dvilualatex" }).setValue(this.plugin.settings.engine).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, engine: v as TikzSettings["engine"] })));
    const paths: Array<[keyof TikzSettings,string]> = [["latexPath","latex path"],["pdflatexPath","pdflatex path"],["xelatexPath","xelatex path"],["lualatexPath","lualatex path"],["dvilualatexPath","dvilualatex path"],["dvisvgmPath","dvisvgm path"],["mutoolPath","mutool path"]];
    for (const [key,name] of paths) new Setting(c).setName(name).addText(t => t.setValue(String(this.plugin.settings[key])).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, [key]: v.trim() })));
    new Setting(c).setName("Asset folder").addText(t => t.setValue(this.plugin.settings.assetFolder).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, assetFolder: normalizePath(v.trim()) })));
    new Setting(c).setName("Cache folder").addText(t => t.setValue(this.plugin.settings.cacheFolder).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, cacheFolder: normalizePath(v.trim()) })));
    new Setting(c).setName("Compile timeout (ms)").addText(t => t.setValue(String(this.plugin.settings.compileTimeout)).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, compileTimeout: Math.max(5000, Math.min(120000, Number(v)||30000)) })));
    new Setting(c).setName("Default zoom").addSlider(s => s.setLimits(25,500,25).setValue(this.plugin.settings.defaultZoom).setDynamicTooltip().onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, defaultZoom:v })));
    new Setting(c).setName("Keep TeX source").addToggle(t => t.setValue(this.plugin.settings.keepTexSource).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, keepTexSource:v })));
    new Setting(c).setName("Persian font").addText(t => t.setValue(this.plugin.settings.persianFont).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, persianFont:v.trim() })));
    new Setting(c).setName("History limit").addSlider(s => s.setLimits(1,100,1).setValue(this.plugin.settings.historyLimit).setDynamicTooltip().onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, historyLimit:v })));
    new Setting(c).setName("Preamble").addTextArea(t => { t.setValue(this.plugin.settings.preamble).onChange(async v => this.plugin.saveSettings({ ...this.plugin.settings, preamble:v })); t.inputEl.rows=18; t.inputEl.cols=80; });
  }
}
