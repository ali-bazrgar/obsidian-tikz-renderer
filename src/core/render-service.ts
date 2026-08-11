import { App, normalizePath } from "obsidian";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { TikzSettings, Engine } from "../settings/settings";
const execFileAsync = promisify(execFile);
const PIPELINE_VERSION = "1";
const MAX_OUTPUT = 2 * 1024 * 1024;
export interface RenderResult { svg: string; hash: string; engine: string; fromCache: boolean; source: string; }
export interface InstallationTest { summary: string; results: Record<string, boolean>; }
export class RenderError extends Error { constructor(message: string, readonly details = "") { super(message); this.name = "RenderError"; } }
export class RenderService {
  private readonly inflight = new Map<string, Promise<RenderResult>>(); private disposed = false;
  constructor(private readonly app: App, private readonly getSettings: () => TikzSettings) {}
  dispose(): void { this.disposed = true; this.inflight.clear(); }
  async render(source: string, kind: string): Promise<RenderResult> {
    if (this.disposed) throw new RenderError("Renderer is shutting down.");
    const s=this.getSettings(), engine=this.selectEngine(source,kind,s.engine), executable=this.executableFor(engine,s), hash=this.hash(source,kind,engine,executable,s);
    const pending=this.inflight.get(hash); if(pending) return pending;
    const task=this.renderInternal(source,kind,engine,executable,hash,s); this.inflight.set(hash,task); try{return await task;}finally{this.inflight.delete(hash);}
  }
  async clearCache(): Promise<void> { await fs.rm(this.cacheRoot(),{recursive:true,force:true}); }
  async detectExecutables(): Promise<Partial<TikzSettings>> {
    const s=this.getSettings(), pairs:Array<[keyof TikzSettings,string]>=[["latexPath","latex"],["pdflatexPath","pdflatex"],["xelatexPath","xelatex"],["lualatexPath","lualatex"],["dvilualatexPath","dvilualatex"],["dvisvgmPath","dvisvgm"],["mutoolPath","mutool"]], out:Partial<TikzSettings>={};
    for(const [key,fallback] of pairs){const current=String(s[key]);if(await this.commandWorks(current)){(out as Record<string,string>)[key]=current;}else if(await this.commandWorks(fallback)){(out as Record<string,string>)[key]=fallback;}} return out;
  }
  async testInstallation(): Promise<InstallationTest> { const s=this.getSettings(), pairs:Array<[string,string]>=[["latex",s.latexPath],["pdflatex",s.pdflatexPath],["xelatex",s.xelatexPath],["lualatex",s.lualatexPath],["dvilualatex",s.dvilualatexPath],["dvisvgm",s.dvisvgmPath],["mutool",s.mutoolPath]], results:Record<string,boolean>={}; for(const [n,e] of pairs) results[n]=await this.commandWorks(e); return {results,summary:pairs.map(([n])=>`${n}: ${results[n]?"OK":"FAILED"}`).join("\n")}; }
  private async renderInternal(source:string,kind:string,engine:string,executable:string,hash:string,s:TikzSettings):Promise<RenderResult>{
    const cache=this.cacheRoot(), svgPath=path.join(cache,`${hash}.svg`); try{return {svg:await fs.readFile(svgPath,"utf8"),hash,engine,fromCache:true,source};}catch{}
    await fs.mkdir(cache,{recursive:true}); const work=path.join(cache,`work-${hash}-${randomBytes(6).toString("hex")}`); await fs.mkdir(work,{recursive:true}); const texPath=path.join(work,"main.tex"); await fs.writeFile(texPath,this.buildDocument(source,kind,s),"utf8");
    try { await this.run(executable,this.compilerArgs(texPath,work),work,s.compileTimeout); const input=path.join(work,engine==="latex"||engine==="dvilualatex"?"main.dvi":"main.pdf"), out=path.join(work,"main.svg"); const args=engine==="latex"||engine==="dvilualatex"?[input,"-n","-o",out]:["--pdf",input,"-n","-o",out]; await this.run(s.dvisvgmPath,args,work,s.compileTimeout); const svg=sanitizeSvg(await fs.readFile(out,"utf8")); await fs.writeFile(svgPath,svg,"utf8"); return {svg,hash,engine,fromCache:false,source}; }
    catch(error){const log=await this.readLog(work); console.error("[TikZ Renderer] rendering failed",{error,hash,engine,work,log}); throw this.normalizeError(error,log);} finally {if(!s.keepTexSource) await fs.rm(work,{recursive:true,force:true}).catch(e=>console.warn("[TikZ Renderer] temp cleanup failed",e));}
  }
  private buildDocument(source:string,kind:string,s:TikzSettings):string { const arabic=/[\u0600-\u06ff]/u.test(source), xep=arabic||/\\usepackage\s*\{\s*xepersian\s*\}|fontspec/u.test(source), body=source.trim(), wrapped=/^\\begin\s*\{(tikzpicture|circuitikz|document)\}/u.test(body)?body:`\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`, lang=xep?`\\usepackage{xepersian}\n\\settextfont{${s.persianFont}}\n`:""; void kind; return `\\documentclass{${xep?"article":"standalone"}}\n${s.preamble}\n${lang}\\begin{document}\n${wrapped}\n\\end{document}\n`; }
  private compilerArgs(tex:string,work:string):string[]{return ["-interaction=nonstopmode","-halt-on-error","-file-line-error","-no-shell-escape","-output-directory",work,tex];}
  private async run(executable:string,args:string[],cwd:string,timeout:number):Promise<void>{try{await execFileAsync(executable,args,{cwd,timeout,windowsHide:true,maxBuffer:MAX_OUTPUT});}catch(e){const x=e as NodeJS.ErrnoException & {killed?:boolean;stdout?:string;stderr?:string};if(x.code==="ENOENT")throw new RenderError(`Executable not found: ${executable}`,x.message);if(x.code==="ETIMEDOUT"||x.killed)throw new RenderError(`Process timed out after ${timeout} ms: ${executable}`,x.stderr??x.message);if(x.code==="EACCES")throw new RenderError(`Permission denied: ${executable}`,x.message);throw new RenderError(`Process failed: ${executable}`,[x.stderr,x.stdout,x.message].filter(Boolean).join("\n"));}}
  private async readLog(work:string):Promise<string>{try{return await fs.readFile(path.join(work,"main.log"),"utf8");}catch{return "No TeX log was produced.";}}
  private normalizeError(error:unknown,log:string):RenderError{const e=error instanceof RenderError?error:new RenderError("TeX/TikZ rendering failed",String(error)), detail=log.length>30000?`${log.slice(-30000)}\n[log truncated]`:log; return new RenderError(`${e.message}\n\n--- TeX log ---\n${detail}`,e.details);}
  private selectEngine(source:string,kind:string,requested:Engine):Exclude<Engine,"auto">{if(requested!=="auto")return requested;if(/\\usepackage\s*\{\s*xepersian\s*\}|fontspec|[\u0600-\u06ff]/u.test(source))return "xelatex";if(/graphdrawing/iu.test(source)&&/lua/iu.test(source))return "lualatex";void kind;return "pdflatex";}
  private executableFor(engine:Exclude<Engine,"auto">,s:TikzSettings):string{return ({latex:s.latexPath,pdflatex:s.pdflatexPath,xelatex:s.xelatexPath,lualatex:s.lualatexPath,dvilualatex:s.dvilualatexPath} as Record<Exclude<Engine,"auto">,string>)[engine];}
  private hash(source:string,kind:string,engine:string,executable:string,s:TikzSettings):string{return createHash("sha256").update(JSON.stringify({source,kind,engine,executable,preamble:s.preamble,font:s.persianFont,dvisvgm:s.dvisvgmPath,pipeline:PIPELINE_VERSION})).digest("hex");}
  private cacheRoot():string{return path.join(this.app.vault.adapter.getBasePath(),normalizePath(this.getSettings().cacheFolder));}
  private async commandWorks(executable:string):Promise<boolean>{try{await execFileAsync(executable,["--version"],{timeout:5000,windowsHide:true,maxBuffer:1024*1024});return true;}catch{return false;}}
}
function sanitizeSvg(svg:string):string{return svg.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi,"");}
