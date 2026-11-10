import {useEffect,useRef,useState} from "react";
import {Button} from "@anansi/ui/components/button";
export function ClientWritePermission({client,onChange}:{client:{id:string;name:string;kind:string;scopes:string;revokedAt:number|null};onChange:()=>void}) {
 const enabled=client.scopes.split(",").includes("write");
 const [pending,setPending]=useState(false),[confirm,setConfirm]=useState(false),[error,setError]=useState(""),[optimistic,setOptimistic]=useState<boolean|null>(null);
 useEffect(()=>setOptimistic(null),[client.scopes]);
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(confirm)dialog.current?.showModal();else dialog.current?.close();},[confirm]);
 if(client.revokedAt !== null || !["api","app"].includes(client.kind))return null;
 async function save(write:boolean){
  setPending(true);setError("");setOptimistic(write);
  try{const response=await fetch(`/api/clients/${encodeURIComponent(client.id)}/permissions`,{method:"PATCH",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({write})});if(!response.ok)throw new Error();setConfirm(false);onChange();}
  catch{setOptimistic(null);setError("Could not change permission. Try again");}
  finally{setPending(false);}
 }
 return <div className="client-write-permission">
  <label><input type="checkbox" checked={optimistic ?? enabled} disabled={pending} onChange={e=>e.target.checked?setConfirm(true):void save(false)}/>Allow changes{pending && " · Saving…"}</label>
  {error && <p role="alert">{error}</p>}
  <dialog ref={dialog} className="client-panel client-write-dialog" onCancel={e=>{if(pending)e.preventDefault();else setConfirm(false);}} aria-labelledby={`write-${client.id}`}>
   <h3 id={`write-${client.id}`}>Allow {client.name} to make changes?</h3>
   <p>Can add tags, notes and save links. Can never delete.</p>
   {error && <p role="alert">{error}</p>}
   <div className="client-actions"><Button autoFocus variant="outline" disabled={pending} onClick={()=>setConfirm(false)}>Keep read-only</Button><Button disabled={pending} onClick={()=>void save(true)}>{pending?"Saving…":"Allow changes"}</Button></div>
  </dialog>
 </div>;
}
