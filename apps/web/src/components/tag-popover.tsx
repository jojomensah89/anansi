import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@anansi/ui/components/button";
import { Checkbox } from "@anansi/ui/components/checkbox";
import { Input } from "@anansi/ui/components/input";
import { Popover, PopoverTrigger, PopoverContent } from "@anansi/ui/components/popover";
import { Plus, Tag } from "lucide-react";
import { api } from "../lib/api";
import { refreshTagKinds } from "../lib/tag-colors.ts";
import { TagDot } from "./tag-chip.tsx";
export interface TagOption {label:string;color:string;count:number;kind:"topic"|"custom"}
export function TagPopover({itemId,current,onChanged,mode="add",overflowCount,iconOnly=true,size="sm",compactLabel=false}:{itemId:string;current:string[];onChanged:()=>void;mode?:"add"|"overflow";overflowCount?:number;iconOnly?:boolean;size?:"sm"|"md";compactLabel?:boolean}) {
 const [open,setOpen]=useState(false),[query,setQuery]=useState(""),[tags,setTags]=useState<TagOption[]>([]),[busy,setBusy]=useState(false);
 useEffect(()=>{if(!open)return;const controller=new AbortController();api.tags(controller.signal).then(r=>setTags(r.tags)).catch(()=>{});return()=>controller.abort()},[open]);
 const needle=query.trim().toLowerCase(),selected=new Set(current.map(s=>s.toLowerCase()));
 const options=[...tags];for(const label of current)if(!options.some(t=>t.label.toLowerCase()===label.toLowerCase()))options.push({label,color:"",count:0,kind:"custom"});
 async function toggle(label:string,next:boolean){setBusy(true);try{if(next)await api.addItemTag(itemId,label);else await api.removeItemTag(itemId,label);onChanged();refreshTagKinds(true);setQuery("")}catch(e){toast.error("Could not update tags",{description:e instanceof Error&&e.message?e.message:undefined})}finally{setBusy(false)}}
 return <span className={mode==="add"?"anansi-tag-add":"anansi-tag-overflow"} onClick={e=>e.stopPropagation()}><Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button variant="ghost" />} className={mode==="add"?"anansi-tag-trigger":"anansi-tag-chip anansi-tag-more"} data-size={size} aria-label={mode==="add"?"Add tags":`Show ${overflowCount??0} more tags`} title={mode==="add"?"Add tags":undefined}>{mode==="add"?(iconOnly?<Tag aria-hidden="true" size={size==="md"?16:14} strokeWidth={1.5}/>:<><Plus aria-hidden="true" size={14} strokeWidth={1.5}/>{size==="sm"&&compactLabel?null:<span className="anansi-tag-add-label">Add tags</span>}</>):`+${overflowCount??0}`}</PopoverTrigger><PopoverContent side="top" align="start" aria-label="Choose tags" style={{width:248}} onClick={e=>e.stopPropagation()}><Input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search or create a tag" aria-label="Search or create a tag" maxLength={100}/><div style={{maxHeight:230,overflowY:"auto"}}>{["topic","custom"].map(kind=><div key={kind}><div style={{fontSize:14,color:"var(--muted)",padding:"8px 0"}}>{kind==="topic"?"Topics":"Your tags"}</div>{options.filter(t=>t.kind===kind&&t.label.toLowerCase().includes(needle)).map(t=><label key={t.label} style={{display:"flex",gap:8,alignItems:"center",minHeight:32,fontSize:14}}><Checkbox checked={selected.has(t.label.toLowerCase())} disabled={busy} onCheckedChange={next=>void toggle(t.label,next)}/>{t.kind==="topic"&&<TagDot label={t.label}/>}<span>{t.label}</span></label>)}</div>)}</div>{needle&&!options.some(t=>t.label.toLowerCase()===needle)&&<Button variant="ghost" disabled={busy} onClick={()=>void toggle(query.trim(),true)}>Create “{query.trim()}”</Button>}</PopoverContent></Popover></span>;
}
