import { requestVisiblePreview } from "../lib/visible-previews.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SourceMark } from "./sourcemark.tsx";
import { mediaUrl, shortDate, type ItemRow } from "../lib/api.ts";
export function webDomain(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Saved page"; } }
const plain = (text?: string | null) => (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Many bookmarks have no description, and the server falls back to the title. Don't print it twice. */
export function sameText(excerpt?: string | null, title?: string | null) { const a = plain(excerpt); return !a || a === plain(title); }
export function WebPreviewCard({item, compact = false, footer, onPreview}: {item: ItemRow; compact?: boolean; footer?: ReactNode; onPreview?: () => void}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onPreview || !element.current || item.previewAttempted || item.media?.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        requestVisiblePreview(item.id, onPreview);
        observer.disconnect();
      }
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [item.id, item.previewAttempted, item.media?.length, onPreview]);
  const [broken, setBroken] = useState(false);
  const [iconBroken, setIconBroken] = useState(false);
  const image = item.media?.find(m => m.kind !== "favicon");
  const favicon = item.media?.find(m => m.kind === "favicon");
  const domain = webDomain(item.url);
  const identity = <span style={{display:"flex",alignItems:"center",gap:8,minWidth:0,fontSize:14,color:"var(--muted)"}}>
    {favicon && !iconBroken ? <img src={mediaUrl(favicon.key)} alt="" width={20} height={20} loading="lazy" onError={()=>setIconBroken(true)} style={{objectFit:"contain",borderRadius:4}} /> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 9h18M8 6h.01M11 6h.01M7 13h10M7 17h6"/></svg>}
    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{domain}</span>
  </span>;
  return <div ref={element} className="web-preview" style={{display:"flex",flexDirection:compact?"row":"column",gap:compact?16:0,width:"100%",minWidth:0,textAlign:"left"}}>
    {image && !broken ? <div style={{aspectRatio:"1.91 / 1",width:compact?"clamp(80px, 24vw, 112px)":"100%",alignSelf:compact?"flex-start":undefined,flexShrink:0,overflow:"hidden",background:"var(--rail)",borderBottom:compact?undefined:"1px solid var(--line)"}}><img key={image.key} src={mediaUrl(image.key)} alt="" loading="lazy" onError={()=>setBroken(true)} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}} /></div> : !compact ? <div style={{padding:"20px 16px 0"}}>{identity}</div> : null}
    <div style={{padding:compact?0:"16px",display:"flex",flexDirection:"column",gap:12,minWidth:0,flex:1}}>
      <div style={{fontSize:16,lineHeight:1.4,fontWeight:600,color:"var(--text)",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",overflowWrap:"anywhere"}}>{item.title || domain}</div>
      {<div style={{height:compact?44.8:67.2,fontSize:14,lineHeight:1.6,color:"var(--text-dim)",display:"-webkit-box",WebkitLineClamp:compact?2:3,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{sameText(item.excerpt, item.title) ? null : item.excerpt}</div>}
      {(compact || (image && !broken)) && identity}
      <div className="mono" data-web-footer style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:8,fontSize:10,color:"var(--faint)"}}>
        {footer}
        <span style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>{shortDate(item.savedAt)}<SourceMark source="web" size={20}/></span>
      </div>
    </div>
  </div>;
}
