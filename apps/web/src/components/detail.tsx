import type { ItemDetail } from "@anansi/db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, mediaUrl, sourceLabel } from "../lib/api.ts";
import { libraryKeys } from "../lib/library-query.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import { Avatar } from "./avatar.tsx";
import { Bone, Loading } from "./skeleton.tsx";
import { TagPopover } from "./tag-popover.tsx";

export function Detail({ id, onClose, focusNote }: { id: string | null; onClose: () => void; focusNote?: boolean }) {
  const queryClient = useQueryClient();
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const detail = useQuery({
    queryKey: libraryKeys.detail(id ?? ""),
    queryFn: ({ signal }) => api.item(id!, signal),
    enabled: !!id,
    retry: 1,
  });
  const item = detail.data ?? null;
  useDialogFocus(!!id, dialog, closeButton, onClose);

  useEffect(() => setNote(item?.note ?? ""), [item?.id, item?.note]);

  useEffect(() => {
		if (!focusNote || !item) return;
		const frame = requestAnimationFrame(() => {
			noteInput.current?.scrollIntoView({ block: "center", behavior: "smooth" });
			noteInput.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [focusNote, item]);

  const update = useMutation({
    mutationFn: (changes: { note?: string; favorite?: boolean; archived?: boolean }) => api.updateItem(id!, changes),
    onSuccess: (next) => {
      queryClient.setQueryData(libraryKeys.detail(next.id), next);
      void queryClient.invalidateQueries({ queryKey: libraryKeys.pages() });
      void queryClient.invalidateQueries({ queryKey: libraryKeys.stats() });
    },
    onError: (error) => toast.error("Could not update this item", { description: message(error) }),
  });
  if (!id) return null;

  const toggle = (field: "favorite" | "archived") => {
    if (!item) return;
    const previous = item[field];
    update.mutate({ [field]: !previous }, {
      onSuccess: () => toast.success(field === "favorite" ? (!previous ? "Added to favorites" : "Removed from favorites") : (!previous ? "Item archived" : "Item restored"), {
        action: { label: "Undo", onClick: () => update.mutate({ [field]: previous }) },
      }),
    });
  };
  const onTagsChanged = () => {
    void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: libraryKeys.pages() });
    void queryClient.invalidateQueries({ queryKey: ["tags"] });
  };

  return (
    <div onMouseDown={(event) => event.target === event.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "#06080a99", zIndex: 40 }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="detail-title" tabIndex={-1} className="scroll" style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 620, maxWidth: "100vw", background: "var(--ink)", borderLeft: "1px solid var(--line)", padding: "20px 26px 32px", animation: "rise 140ms ease-out both", outline: "none" }}>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="Close item detail" style={{ position: "sticky", top: 0, zIndex: 2, float: "right", width: 32, height: 32, borderRadius: 6, border: "1px solid var(--edge)", background: "var(--card)", color: "var(--muted)", cursor: "pointer" }}>×</button>
        {detail.isError && <div role="alert" style={{ color: "#f2a7a7", fontSize: 13 }}>{message(detail.error)} <button type="button" onClick={() => void detail.refetch()} style={linkButton}>Retry</button></div>}
        {detail.isPending && <Loading label="Loading this item"><div style={{ display: "flex", gap: 11, marginBottom: 20 }}><Bone width={38} height={38} radius={19} /><Bone width="45%" height={12} /></div><Bone height={12} /><Bone width="78%" height={12} /><Bone height={260} radius={8} /></Loading>}

        {item && <>
          <header style={{ paddingRight: 42, marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <Avatar src={item.authorAvatar} seed={item.author ?? item.authorName} square={item.source === "github"} size={38} />
              <div style={{ minWidth: 0 }}>
                <h1 id="detail-title" style={{ margin: 0, fontSize: 17, lineHeight: 1.35 }}>{item.title ?? item.authorName ?? item.author ?? "Untitled save"}</h1>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 3 }}>{sourceLabel(item.source)}{item.author ? ` · ${item.author}` : ""}{item.postedAt ? ` · ${new Date(item.postedAt * 1000).toLocaleDateString("en-GB", { timeZone: "UTC" })}` : ""}</div>
              </div>
            </div>
          </header>

          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 20 }}>
            <Action active={item.favorite} onClick={() => toggle("favorite")}>{item.favorite ? "★ Favorited" : "☆ Favorite"}</Action>
            <Action active={item.archived} onClick={() => toggle("archived")}>{item.archived ? "Restore" : "Archive"}</Action>
            <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ ...actionStyle, textDecoration: "none" }}>Open source ↗</a>
          </div>

          {item.fullText && item.fullText !== item.articleText && <Section label="Saved text"><div style={bodyStyle}>{item.fullText}</div></Section>}

          {item.articleText ? <Section label="Article"><Article text={item.articleText} format={item.articleFormat} />{item.contentTruncated && <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 10 }}>The captured article reached Anansi’s storage limit. Open the source for the remainder.</div>}</Section> : !item.fullText ? <Section label="Content"><div style={{ color: "var(--faint)", fontSize: 13 }}>Only page metadata was available when this item was saved.</div></Section> : null}

          {item.highlights.length > 0 && <Section label={`Highlights · ${item.highlights.length}`}><div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{item.highlights.map((highlight) => <blockquote key={highlight.id} style={{ margin: 0, padding: "9px 12px", borderLeft: "2px solid var(--accent)", background: "var(--card)", color: "var(--text-dim)", fontSize: 13.5, lineHeight: 1.58, whiteSpace: "pre-wrap" }}>{highlight.text}<footer className="mono" style={{ marginTop: 5, color: "var(--faint)", fontSize: 9.5 }}>{new Date(highlight.createdAt * 1000).toLocaleDateString("en-GB", { timeZone: "UTC" })}</footer></blockquote>)}</div></Section>}

          {item.media.some((entry) => entry.storedKey) && <Section label={`Stored media · ${item.media.filter((entry) => entry.storedKey).length}`}><div style={{ display: "grid", gridTemplateColumns: item.media.filter((entry) => entry.storedKey).length === 1 ? "1fr" : "repeat(2, 1fr)", gap: 8 }}>{item.media.filter((entry) => entry.storedKey).map((entry, index) => <a key={entry.originUrl} href={mediaUrl(entry.storedKey!)} target="_blank" rel="noopener noreferrer" aria-label={`Open stored image ${index + 1}`}><img src={mediaUrl(entry.storedKey!)} alt="" loading="lazy" style={{ width: "100%", display: "block", borderRadius: 7, border: "1px solid var(--line)" }} /></a>)}</div></Section>}

          <Section label="Tags">
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {(item.tagMeta?.length ? item.tagMeta : item.tags.map((label) => ({ label, color: "#6b7280" }))).map((tag) => (
                <span key={tag.label} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, minHeight: 26, padding: "0 8px", borderRadius: 5, background: `${tag.color}22`, color: tag.color, fontSize: 10.5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: tag.color }} />
                  {tag.label}
                </span>
              ))}
              <TagPopover itemId={item.id} current={item.tags} onChanged={onTagsChanged} />
            </div>
          </Section>

          <Section label="Private note">
            <label htmlFor="item-note" className="sr-only">Private note</label>
            <textarea ref={noteInput} id="item-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={20_000} rows={5} style={{ ...inputStyle, width: "100%", minHeight: 110, padding: 10, resize: "vertical", lineHeight: 1.5 }} />
            <div style={{ display: "flex", alignItems: "center", marginTop: 7 }}><span className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>{note.length.toLocaleString()} / 20,000</span><button type="button" disabled={note === item.note || update.isPending} onClick={() => update.mutate({ note }, { onSuccess: () => toast.success("Note saved") })} style={{ ...actionStyle, marginLeft: "auto" }}>Save note</button></div>
          </Section>

          <details style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><summary className="mono" style={{ color: "var(--faint)", cursor: "pointer", fontSize: 10.5 }}>Record and provenance</summary><div style={{ marginTop: 10 }}><Row k="source" v={item.source} /><Row k="id" v={item.id} /><Row k="saved" v={item.savedAtExact ? new Date(item.savedAt * 1000).toISOString() : "import time, not exact"} /><Row k="at source" v={item.platformSaved ? "still saved" : "removed at source"} /><Row k="stored media" v={String(item.media.filter((entry) => entry.storedKey).length)} /><Row k="indexed" v="keyword search" /></div></details>
        </>}
      </div>
    </div>
  );
}

function Article({ text, format }: { text: string; format: "plain" | "markdown" }) {
  if (format === "plain") return <div style={articleStyle}>{text}</div>;
  return <div style={articleStyle}>{text.split(/(```[\s\S]*?```)/g).map((part, index) => part.startsWith("```") ? <pre key={index} style={{ overflowX: "auto", padding: 12, borderRadius: 6, background: "#090c0f", fontSize: 12, whiteSpace: "pre" }}><code>{part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre> : <MarkdownLines key={index} text={part} />)}</div>;
}

function MarkdownLines({ text }: { text: string }) {
  return <>{text.split("\n").map((line, index) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) return <div key={index} style={{ fontSize: 20 - heading[1]!.length * 2, fontWeight: 650, margin: "18px 0 7px", color: "var(--text)" }}>{heading[2]}</div>;
    if (/^[-*]\s+/.test(line)) return <div key={index} style={{ paddingLeft: 14 }}>• {line.replace(/^[-*]\s+/, "")}</div>;
    if (/^>\s?/.test(line)) return <blockquote key={index} style={{ margin: "8px 0", paddingLeft: 12, borderLeft: "2px solid var(--edge-strong)", color: "var(--muted)" }}>{line.replace(/^>\s?/, "")}</blockquote>;
    return <div key={index} style={{ minHeight: line ? undefined : 12 }}>{line}</div>;
  })}</>;
}

function Action({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) { return <button type="button" onClick={onClick} style={{ ...actionStyle, color: active ? "var(--accent)" : "var(--text-dim)" }}>{children}</button>; }
function Section({ label, children }: { label: string; children: React.ReactNode }) { return <section style={{ marginBottom: 22 }}><h2 className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--fainter)", margin: "0 0 9px" }}>{label}</h2>{children}</section>; }
function Row({ k, v }: { k: string; v: string }) { return <div className="mono" style={{ display: "flex", gap: 18, justifyContent: "space-between", fontSize: 10.5, marginBottom: 5 }}><span style={{ color: "var(--faint)" }}>{k}</span><span style={{ color: "var(--muted)", textAlign: "right", overflowWrap: "anywhere" }}>{v}</span></div>; }

const bodyStyle = { fontSize: 14.5, lineHeight: 1.65, color: "var(--text-dim)", whiteSpace: "pre-wrap" } as const;
const articleStyle = { ...bodyStyle, fontSize: 15, lineHeight: 1.72 } as const;
const actionStyle = { minHeight: 31, display: "inline-flex", alignItems: "center", border: "1px solid var(--edge)", borderRadius: 5, padding: "0 10px", background: "var(--card)", color: "var(--text-dim)", cursor: "pointer", font: "inherit", fontSize: 11.5 } as const;
const linkButton = { border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", font: "inherit" } as const;
const inputStyle = { minHeight: 32, flex: 1, border: "1px solid var(--edge)", borderRadius: 5, background: "var(--card)", color: "var(--text)", padding: "0 9px", font: "inherit", fontSize: 12.5 } as const;
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
