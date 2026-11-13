import { requestVisiblePreview } from "../lib/visible-previews.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { mediaUrl, shortDate, type ItemRow } from "../lib/api.ts";
import { SourceMark } from "./sourcemark.tsx";
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
  const image = item.media?.find(m => m.kind !== "favicon");
  const domain = webDomain(item.url);
  const favicon = item.media?.find(m => m.kind === "favicon")?.key;
  // Only the compact row names its site here; the grid card says it once, in its identity line.
  const identity = compact ? <span className="web-preview-site">
    <SourceMark source="web" faviconUrl={favicon ? mediaUrl(favicon) : undefined} size={14} decorative />
    <span className="web-preview-site-name">{domain}</span>
  </span> : null;
  return <div ref={element} className="web-preview" style={{display:"flex",flexDirection:compact?"row":"column",gap:compact?16:0,width:"100%",minWidth:0,textAlign:"left"}}>
    {image && !broken ? <div className="web-preview-media" style={{aspectRatio:"1.91 / 1",width:compact?"clamp(80px, 24vw, 112px)":"100%",alignSelf:compact?"flex-start":undefined,flexShrink:0,overflow:"hidden",background:"var(--rail)",borderBottom:compact?undefined:"1px solid var(--line)"}}><img key={image.key} src={mediaUrl(image.key)} alt="" loading="lazy" onError={()=>setBroken(true)} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}} /></div> : null}
    <div className="web-preview-copy" style={{padding:compact?0:"16px",display:"flex",flexDirection:"column",gap:12,minWidth:0,flex:1}}>
      <div style={{fontSize:16,lineHeight:1.4,fontWeight:600,color:"var(--text)",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",overflowWrap:"anywhere"}}>{item.title || domain}</div>
      {<div style={{fontSize:14,lineHeight:1.6,color:"var(--text-dim)",display:"-webkit-box",WebkitLineClamp:compact?2:3,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{sameText(item.excerpt, item.title) ? null : item.excerpt}</div>}
      {identity}
      <div data-web-footer>{footer ?? <span>{shortDate(item.savedAt)}</span>}</div>
    </div>
  </div>;
}
