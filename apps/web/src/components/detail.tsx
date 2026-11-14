import { Textarea } from "@anansi/ui/components/textarea";
import { Button, buttonVariants } from "@anansi/ui/components/button";
import { SectionTitle } from "@anansi/ui/components/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, mediaUrl, shortDate, type ItemRow } from "../lib/api.ts";
import { webDomain } from "./web-preview-card.tsx";
import { libraryKeys } from "../lib/library-query.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import { SourceMark } from "./sourcemark.tsx";
import { CaptureTrail } from "./capture-trail.tsx";
import { Avatar } from "./avatar.tsx";
import { Bone, Loading } from "./skeleton.tsx";
import { TagPopover } from "./tag-popover.tsx";
import { TagChip } from "./tag-chip.tsx";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@anansi/ui/components/tooltip";
import { Archive, ArchiveRestore, BookMinus, BookPlus, ExternalLink, Star, X } from "lucide-react";
import { useShelfMembership } from "../lib/shelf-queries.ts";
import { ShelfPickerPopover, useViewingShelf } from "./shelf-picker.tsx";
import { formatCount } from "../lib/format.ts";

type ItemDetailRow = Awaited<ReturnType<typeof api.updateItem>>;

type NoteState = "idle" | "saving" | "saved" | "error";

export function Detail({ id, onClose, focusNote }: { id: string | null; onClose: () => void; focusNote?: boolean }) {
  const queryClient = useQueryClient();
  const dialog = useRef<HTMLDivElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const [shownId, setShownId] = useState(id);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (id) { setShownId(id); if(document.documentElement.dataset.input === "keyboard" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {setVisible(true);return;} let second = 0; const frame = requestAnimationFrame(() => {second = requestAnimationFrame(() => setVisible(true));}); return () => {cancelAnimationFrame(frame);cancelAnimationFrame(second);}; }
    setVisible(false);
    if (document.documentElement.dataset.input === "keyboard" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {setShownId(null);return;}
    const timer = setTimeout(() => setShownId(null), 160); return () => clearTimeout(timer);
  }, [id]);
  const detail = useQuery({
    queryKey: libraryKeys.detail(shownId ?? ""),
    queryFn: ({ signal }) => api.item(shownId!, signal),
    enabled: !!shownId,
    retry: 1,
  });
  const item = detail.data ?? null;
  const stored = item?.media.filter((entry) => entry.storedKey) ?? [];
  const favicon = item?.media.find((entry) => entry.kind === "favicon")?.storedKey;
  useDialogFocus(!!id, dialog, dialog, onClose, true);

  const refresh = (next: ItemDetailRow) => {
    // The PATCH reply has no shelf list; keep the one the picker reads.
    queryClient.setQueryData<ItemDetailRow & { shelves?: string[] }>(libraryKeys.detail(next.id), (old) => ({ ...next, shelves: (next as { shelves?: string[] }).shelves ?? old?.shelves }));
    void queryClient.invalidateQueries({ queryKey: libraryKeys.pages() });
    void queryClient.invalidateQueries({ queryKey: libraryKeys.stats() });
  };
  const update = useMutation({
    mutationFn: (changes: { favorite?: boolean; archived?: boolean }) => api.updateItem(id!, changes),
    onSuccess: refresh,
    onError: (error) => toast.error("Could not update this item", { description: message(error) }),
  });

  /*
   * The note saves itself: after a pause in typing, and at once on blur or when
   * the inspector moves to another item. A failed save keeps the text in the box
   * and says so; the server's copy never replaces text that differs from what
   * was last saved.
   */
  const [note, setNote] = useState("");
  const [noteState, setNoteState] = useState<NoteState>("idle");
  const saved = useRef("");
  const noteNow = useRef("");
  const saveNote = useMutation({
    mutationFn: ({ itemId, text }: { itemId: string; text: string }) => api.updateItem(itemId, { note: text }),
    onSuccess: refresh,
  });
  const flush = (itemId: string | undefined) => {
    const text = noteNow.current;
    if (!itemId || text === saved.current) return;
    setNoteState("saving");
    saveNote.mutate({ itemId, text }, {
      onSuccess: () => { saved.current = text; setNoteState(noteNow.current === text ? "saved" : "idle"); },
      onError: () => setNoteState("error"),
    });
  };
  const flushRef = useRef(flush);
  // Effects and timers read the latest text and save function, never a stale closure.
  useLayoutEffect(() => { noteNow.current = note; flushRef.current = flush; });
  useEffect(() => {
    const value = item?.note ?? "";
    saved.current = value;
    setNote(value);
    setNoteState("idle");
    const itemId = item?.id;
    return () => flushRef.current(itemId);
  }, [item?.id]);
  useEffect(() => {
    // Another client changed the note: follow it only when nothing local is pending.
    if (item && (item.note ?? "") !== saved.current && noteNow.current === saved.current) { saved.current = item.note ?? ""; setNote(item.note ?? ""); }
  }, [item?.note]);
  useEffect(() => {
    if (!item || note === saved.current) return;
    const timer = setTimeout(() => flushRef.current(item.id), 900);
    return () => clearTimeout(timer);
  }, [note, item?.id]);

  useEffect(() => {
		if (!focusNote || !item) return;
		const frame = requestAnimationFrame(() => {
			noteInput.current?.scrollIntoView({ block: "center", behavior: "smooth" });
			noteInput.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [focusNote, item]);

  if (!shownId) return null;

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
    void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(shownId!) });
    void queryClient.invalidateQueries({ queryKey: libraryKeys.pages() });
    void queryClient.invalidateQueries({ queryKey: ["tags"] });
  };
  const dirty = note !== saved.current;

  return (
    <div className="inspector-slot" data-visible={visible && !!id} inert={!id}>
      <div ref={dialog} role="dialog"  aria-labelledby="detail-title" tabIndex={-1} className="scroll workspace-inspector">
        <TooltipProvider delay={400}>
          <div className="detail-bar" role="toolbar" aria-label="Item actions">
            {item && <>
              <IconAction label={item.favorite ? "Remove from favorites" : "Add to favorites"} pressed={item.favorite} onClick={() => toggle("favorite")}>
                <Star aria-hidden="true" strokeWidth={1.5} fill={item.favorite ? "currentColor" : "none"} />
              </IconAction>
              <IconAction label={item.archived ? "Unarchive" : "Archive"} onClick={() => toggle("archived")}>
                {item.archived ? <ArchiveRestore aria-hidden="true" strokeWidth={1.5} /> : <Archive aria-hidden="true" strokeWidth={1.5} />}
              </IconAction>
              <InspectorShelves itemId={item.id} shelves={item.shelves} />
              <IconAction label="Open original" href={item.url}>
                <ExternalLink aria-hidden="true" strokeWidth={1.5} />
              </IconAction>
              <span className="detail-bar-rule" aria-hidden="true" />
            </>}
            <IconAction label="Close" ariaLabel="Close item detail" onClick={onClose}>
              <X aria-hidden="true" strokeWidth={1.5} />
            </IconAction>
          </div>
        </TooltipProvider>
        {detail.isError && <div role="alert" style={{ color: "var(--danger)", fontSize: "var(--text-body)" }}>{message(detail.error)} <Button variant="ghost" type="button" onClick={() => void detail.refetch()} style={linkButton}>Retry</Button></div>}
        {detail.isPending && <Loading label="Loading this item"><div style={{ display: "flex", gap: 12, marginBottom: 20 }}><Bone width={40} height={40} radius={20} /><Bone width="45%" height={12} /></div><Bone height={12} /><Bone width="78%" height={12} /><Bone height={260} radius={8} /></Loading>}

        {item && <>
          <header className="detail-header">
            <Avatar src={item.authorAvatar} seed={item.author ?? item.authorName} name={item.authorName} square={item.source === "github"} size={40} />
            <div style={{ minWidth: 0 }}>
              <h1 id="detail-title" className="detail-title">{item.title ?? item.authorName ?? item.author ?? "Untitled save"}</h1>
              <div className="detail-meta">
                <SourceMark source={item.source} size={14} faviconUrl={favicon ? mediaUrl(favicon) : undefined} />
                <span>{[byline(item), shortDate(item.source === "web" ? item.savedAt : item.postedAt)].filter(Boolean).join(" · ")}</span>
              </div>
            </div>
          </header>

          {item.fullText && item.fullText !== item.articleText && <Section><div style={bodyStyle}>{item.fullText}</div></Section>}

          {item.articleText ? <Section label={item.fullText && item.fullText !== item.articleText ? "Article" : undefined}><Article text={item.articleText} format={item.articleFormat} />{item.contentTruncated && <div style={{ fontSize: "var(--text-meta)", color: "var(--muted)", marginTop: 12 }}>The article reached the storage limit. Open the original for the rest.</div>}</Section> : !item.fullText ? <Section><div style={{ color: "var(--muted)", fontSize: "var(--text-body)" }}>No page text was captured</div></Section> : null}

          {item.highlights.length > 0 && <Section label="Highlights"><div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{item.highlights.map((highlight) => <blockquote key={highlight.id} style={{ margin: 0, padding: "8px 12px", borderLeft: "2px solid var(--accent)", background: "var(--card)", color: "var(--text-dim)", fontSize: "var(--text-body)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{highlight.text}<footer style={{ marginTop: 4, color: "var(--muted)", fontSize: "var(--text-meta)" }}>{shortDate(highlight.createdAt)}</footer></blockquote>)}</div></Section>}

          {stored.length > 0 && <Section ariaLabel="Media"><div className="detail-media" data-count={stored.length === 1 ? 1 : 2}>{stored.map((entry, index) => <a key={entry.originUrl} href={mediaUrl(entry.storedKey!)} target="_blank" rel="noopener noreferrer" aria-label={`Open image ${index + 1}`}><img src={mediaUrl(entry.storedKey!)} alt="" loading="lazy" /></a>)}</div></Section>}

          <Section ariaLabel="Tags">
            <div className="detail-tags">
              {item.tags.map((label) => <TagChip key={label} label={label} />)}
              <TagPopover itemId={item.id} current={item.tags} onChanged={onTagsChanged} />
              {item.taggingState?.status === "failed" ? <span title={item.taggingState.lastError ?? undefined} style={{ fontSize: "var(--text-meta)", color: "var(--danger)" }}>Auto-tagging failed</span> : !item.tags.length && ["pending", "retrying", "running"].includes(item.taggingState?.status ?? "") ? <span style={{ fontSize: "var(--text-meta)", color: "var(--muted)" }}>Tagging pending</span> : null}
            </div>
          </Section>

          <Section>
            <label htmlFor="item-note" className="sr-only">Private note</label>
            <Textarea ref={noteInput} id="item-note" className="detail-note" placeholder="Add a private note" value={note} onChange={(event) => { setNote(event.target.value); if (noteState !== "saving") setNoteState("idle"); }} onBlur={() => flush(item.id)} maxLength={20_000} rows={3} aria-describedby="item-note-status" />
            <div className="detail-note-foot">
              <span id="item-note-status" role="status" data-state={noteState} className="detail-note-status">
                {noteState === "saving" ? "Saving" : noteState === "error" ? "Not saved, your text is kept" : noteState === "saved" && !dirty ? "Saved" : ""}
              </span>
              {noteState === "error" && <Button variant="ghost" size="sm" type="button" className="detail-note-retry" onClick={() => flush(item.id)}>Retry</Button>}
              {note.length > 19_000 && <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{formatCount(note.length)} / 20,000</span>}
            </div>
          </Section>

          <details className="detail-record">
            <summary>Details</summary>
            <CaptureTrail item={item} tagging={false} />
            <dl>
              <Row k="Saved" v={item.savedAtExact ? new Date(item.savedAt * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Import time, not exact"} />
              <Row k="At source" v={item.platformSaved ? "Still saved" : "Removed"} />
              <Row k="ID" v={item.id} />
            </dl>
          </details>
        </>}
      </div>
    </div>
  );
}

/** One icon action in the inspector bar: the same 32px box and 16px icon as the library toolbar. */
function IconAction({ label, ariaLabel, pressed, onClick, href, children }: { label: string; ariaLabel?: string; pressed?: boolean; onClick?: () => void; href?: string; children: React.ReactNode }) {
  const trigger = href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className={`${buttonVariants({ variant: "ghost", size: "icon" })} detail-action`} aria-label={ariaLabel ?? label} />
    : <Button variant="ghost" size="icon" className="detail-action" type="button" onClick={onClick} aria-label={ariaLabel ?? label} aria-pressed={pressed} />;
  return <Tooltip><TooltipTrigger render={trigger}>{children}</TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>;
}

/**
 * Add to shelf, and Remove from the shelf being viewed when this save is on it.
 * The picker opens under its button and lists the shelves with check marks.
 */
function InspectorShelves({ itemId, shelves }: { itemId: string; shelves?: string[] }) {
  const viewing = useViewingShelf();
  const membership = useShelfMembership();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const onViewed = !!viewing && (shelves === undefined || shelves.includes(viewing.id));
  return <>
    <Tooltip>
      <TooltipTrigger render={<Button ref={anchor} variant="ghost" size="icon" className="detail-action" type="button" aria-label="Add to shelf" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} />}>
        <BookPlus aria-hidden="true" strokeWidth={1.5} />
      </TooltipTrigger>
      <TooltipContent side="bottom">Add to shelf</TooltipContent>
    </Tooltip>
    <ShelfPickerPopover itemIds={[itemId]} open={open} onOpenChange={setOpen} anchor={anchor} align="start" />
    {viewing && onViewed && (
      <IconAction label={`Remove from ${viewing.name}`} onClick={() => membership.mutate({ shelf: viewing, itemIds: [itemId], on: false })}>
        <BookMinus aria-hidden="true" strokeWidth={1.5} />
      </IconAction>
    )}
  </>;
}

function Article({ text, format }: { text: string; format: "plain" | "markdown" }) {
  if (format === "plain") return <div style={articleStyle}>{text}</div>;
  return <div style={articleStyle}>{text.split(/(```[\s\S]*?```)/g).map((part, index) => part.startsWith("```") ? <pre key={index} style={{ overflowX: "auto", padding: 12, borderRadius: 6, background: "var(--rail)", fontSize: "var(--text-body)", whiteSpace: "pre" }}><code>{part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre> : <MarkdownLines key={index} text={part} />)}</div>;
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

function Section({ label, ariaLabel, children }: { label?: string; ariaLabel?: string; children: React.ReactNode }) { return <section aria-label={ariaLabel} style={{ marginBottom: 24 }}>{label && <SectionTitle>{label}</SectionTitle>}{children}</section>; }
function Row({ k, v }: { k: string; v: string }) { return <div><dt>{k}</dt><dd>{v}</dd></div>; }
/** The logo already names the platform, so the meta line carries only who and where. */
function byline(item: Pick<ItemRow, "source" | "author" | "url">) {
  if (item.source === "web") return webDomain(item.url);
  if (!item.author || item.source === "github") return "";
  return item.source === "reddit" ? `u/${item.author}` : `@${item.author}`;
}

const bodyStyle = { fontSize: 15, lineHeight: 1.6, color: "var(--text-dim)", whiteSpace: "pre-wrap" } as const;
const articleStyle = { ...bodyStyle, lineHeight: 1.7 } as const;
const linkButton = { border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", font: "inherit" } as const;
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
