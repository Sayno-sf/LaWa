import {createHash} from "node:crypto";
import type {ModelRuntime} from "@earendil-works/pi-coding-agent";

export function isOpenCodeGo(baseUrl:string|undefined):boolean {
  try {
    const url=new URL(baseUrl??"");
    return url.origin==="https://opencode.ai" && ["/inference/go/openai/v1","/zen/go/v1"].includes(url.pathname.replace(/\/$/,""));
  } catch {return false;}
}

const installed=new WeakSet<object>();

/** 仅装饰Go请求选项；保留SDK鉴权、流、取消、重试及原onPayload，不另建代理或改写对话。 */
export function configureOpenCodeGoRuntime(value:object):void {
  const runtime=value as Pick<ModelRuntime,"streamSimple">;
  if(installed.has(value)||typeof runtime.streamSimple!=="function") return;
  const stream=runtime.streamSimple.bind(runtime);
  runtime.streamSimple=(model,context,options)=>{
    if(!isOpenCodeGo(model.baseUrl)) return stream(model,context,options);
    const scope=typeof options?.sessionId==="string" && options.sessionId.length<=300 ? options.sessionId : "auxiliary";
    // 路由只需稳定标识，不发送本地会话ID；模型/工具内容仍由原用户请求决定。
    const session=createHash("sha256").update(JSON.stringify(["LaWa-Go",model.provider,scope])).digest("hex");
    return stream(model,context,{...options,transformHeaders:async(headers)=>{
      const result={...await (options?.transformHeaders?.(headers)??headers)};
      for(const name of Object.keys(result)) if(["session_id","x-session-id","x-session-affinity","x-client-request-id","x-opencode-session","user-agent"].includes(name.toLowerCase())) delete result[name];
      return {...result,"User-Agent":"LaWa-LearningAgent/0.1","x-opencode-session":session};
    }});
  };
  installed.add(value);
}
