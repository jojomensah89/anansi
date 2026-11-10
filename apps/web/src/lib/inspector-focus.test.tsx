import {test,expect} from "bun:test";
// @ts-expect-error jsdom is a test-only dependency without declarations.
import {JSDOM} from "jsdom";
import {act,useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {useDialogFocus} from "./use-dialog-focus";

test("inspector opens, Escape closes and restores the opener",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost"});
 const keys=["window","document","navigator","HTMLElement","IS_REACT_ACT_ENVIRONMENT","requestAnimationFrame","cancelAnimationFrame"];
 const previous=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
 for(const k of keys)Object.defineProperty(globalThis,k,{configurable:true,value:k==="IS_REACT_ACT_ENVIRONMENT"?true:k==="requestAnimationFrame"?((f:()=>void)=>setTimeout(f,0)):k==="cancelAnimationFrame"?clearTimeout:(dom.window as any)[k]});
 function Harness(){const [open,setOpen]=useState(false);const pane=useRef<HTMLDivElement>(null);const close=useRef<HTMLButtonElement>(null);useDialogFocus(open,pane,close,()=>setOpen(false),true);return <><button id="opener" onClick={()=>setOpen(true)}>Open</button>{open&&<div ref={pane} role="dialog"><button ref={close} onClick={()=>setOpen(false)}>Close</button></div>}</>}
 const root=createRoot(document.getElementById("root")!);
 try{await act(async()=>root.render(<Harness/>));const opener=document.getElementById("opener")!;opener.focus();await act(async()=>opener.click());expect(document.querySelector('[role=dialog]')).not.toBeNull();await act(async()=>document.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true})));expect(document.querySelector('[role=dialog]')).toBeNull();expect(document.activeElement).toBe(opener);}finally{await act(async()=>root.unmount());keys.forEach((k,i)=>{if(previous[i])Object.defineProperty(globalThis,k,previous[i]!);else delete (globalThis as any)[k]});dom.window.close();}
});
