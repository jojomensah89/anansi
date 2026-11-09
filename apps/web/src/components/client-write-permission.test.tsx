import {test,expect} from "bun:test";
// @ts-expect-error jsdom is a test-only dependency without declarations in this workspace.
import {JSDOM} from "jsdom";
import {createElement,act} from "react";
import {createRoot} from "react-dom/client";
import {ClientWritePermission} from "./client-write-permission.tsx";
test("permission confirmation, pending, failure, disabling and ineligible rows",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost"});
 const keys=["window","document","navigator","HTMLElement","IS_REACT_ACT_ENVIRONMENT"];
 const previous=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
 for(const k of keys)Object.defineProperty(globalThis,k,{configurable:true,value:k==="IS_REACT_ACT_ENVIRONMENT"?true:(dom.window as any)[k]});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};
 dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};
 const original=globalThis.fetch;const root=createRoot(document.getElementById("root")!);
 const client={id:"fixture",name:"Research",kind:"api",scopes:"read",revokedAt:null as number|null};let changes=0;let resolve!:(r:Response)=>void;let request:RequestInit|undefined;
 globalThis.fetch=((_url:any,init:any)=>{request=init;return new Promise<Response>(r=>resolve=r);}) as typeof fetch;
 const render=async(c=client)=>{await act(async()=>root.render(createElement(ClientWritePermission,{client:c,onChange:()=>changes++})));};
 try{
 await render();const input=()=>document.querySelector<HTMLInputElement>('input')!;
 expect(input().checked).toBe(false);
 await act(async()=>input().click());expect(document.querySelector('dialog[open]')).not.toBeNull();expect(document.body.textContent).toContain("Can never delete.");expect(request).toBeUndefined();
 await act(async()=>{(document.querySelector('dialog button:last-child') as HTMLButtonElement).click();});
 expect(input().disabled).toBe(true);expect(input().checked).toBe(true);expect(request?.credentials).toBe("same-origin");expect(request?.body).toBe('{"write":true}');expect((request?.headers as any).Authorization).toBeUndefined();
 await act(async()=>resolve(new Response('{}',{status:403})));expect(input().checked).toBe(false);expect(document.querySelector('[role=alert]')).not.toBeNull();
 await act(async()=>{(document.querySelector('dialog button:last-child') as HTMLButtonElement).click();});await act(async()=>resolve(new Response('{}')));expect(changes).toBe(1);
 await render({...client,scopes:"read,write"});expect(input().checked).toBe(true);
 await act(async()=>input().click());expect(request?.body).toBe('{"write":false}');await act(async()=>resolve(new Response('{}')));
 for(const c of [{...client,revokedAt:1},{...client,kind:"extension"},{...client,kind:"pairing"}]){await render(c);expect(document.querySelector('input')).toBeNull();}
 }finally{await act(async()=>root.unmount());globalThis.fetch=original;keys.forEach((k,i)=>{if(previous[i])Object.defineProperty(globalThis,k,previous[i]!);else delete (globalThis as any)[k];});dom.window.close();}
});
