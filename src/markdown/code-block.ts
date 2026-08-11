import { MarkdownPostProcessorContext } from "obsidian";
import { RenderService } from "../core/render-service";
import { TikzRendererView } from "../ui/renderer-view";
export class TikzMarkdownProcessor {
  static async process(source:string,el:HTMLElement,ctx:MarkdownPostProcessorContext,service:RenderService):Promise<void>{void ctx; const kind=this.kindFromElement(el),host=el.createDiv({cls:"tikz-renderer-block"}); el.empty(); host.createDiv({cls:"tikz-renderer-status",text:"Rendering TikZ…"}); try{const result=await service.render(source,kind);if(!el.isConnected)return;new TikzRendererView(host,result,source,service).render();}catch(error){host.empty();const card=host.createDiv({cls:"tikz-renderer-error"});card.createEl("strong",{text:"TeX/TikZ rendering failed"});card.createEl("pre",{text:error instanceof Error?error.message:String(error)});}}
  private static kindFromElement(el:HTMLElement):string{const code=el.querySelector("code"),m=code?.className.match(/language-([\w-]+)/);return m?.[1]??"tikz";}
}
