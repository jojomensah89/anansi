import { useEffect, useState } from "react";
import type { ItemDetail } from "@anansi/db";
import { api, compact, mediaUrl } from "../lib/api.ts";
import { Bone, Loading } from "./skeleton.tsx";

/**
 * The item detail, as a drawer rather than a route.
 *
 * The canvas note: "Detail keeps the record visible — source, external_id,
 * stored media, index state — because this is a tool for someone who owns
 * their data, not a reader." So the Record block at the bottom is the point,
 * not decoration.
 *
 * A drawer and not a page because opening something from the grid or the
 * palette should not cost you your scroll position or your search.
 */
export function Detail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setItem(null);
      return;
    }
    const controller = new AbortController();
    setItem(null);
    setError(null);
    api
      .item(id, controller.signal)
      .then(setItem)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, onClose]);

  if (!id) return null;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "#06080a99", zIndex: 40 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="scroll"
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 560,
          maxWidth: "100vw",
          background: "var(--ink)",
          borderLeft: "1px solid var(--line)",
          padding: "22px 26px",
          animation: "rise 140ms ease-out both",
        }}
      >
        {error && <div style={{ color: "var(--muted)", fontSize: 13 }}>{error}</div>}
        {/*
          Shaped like the drawer it becomes: an author line, a paragraph, then
          the media. The drawer is already animating in, so a second thing
          appearing a moment later would read as a stutter.
        */}
        {!item && !error && (
          <Loading label="Loading this item">
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 20 }}>
              <Bone width={38} height={38} radius={19} />
              <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                <Bone width="40%" height={11} delay={60} />
                <Bone width="26%" height={9} delay={90} />
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
              <Bone height={10} delay={120} />
              <Bone height={10} delay={150} />
              <Bone width="76%" height={10} delay={180} />
            </div>
            <Bone height={280} radius={8} delay={210} />
          </Loading>
        )}

        {item && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 20 }}>
              {item.authorAvatar ? (
                <img
                  src={item.authorAvatar}
                  alt=""
                  width={38}
                  height={38}
                  style={{
                    borderRadius: item.source === "github" ? 6 : "50%",
                    flexShrink: 0,
                    objectFit: "cover",
                    background: "var(--edge-strong)",
                  }}
                />
              ) : (
                <span
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: item.source === "github" ? 6 : "50%",
                    background: "var(--edge-strong)",
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                  {item.authorName ?? item.author ?? "unknown"}
                </span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>
                  @{item.author ?? "unknown"}
                  {item.postedAt ? ` · ${new Date(item.postedAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                </span>
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mono"
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--text-dim)",
                  border: "1px solid var(--edge)",
                  borderRadius: 5,
                  padding: "6px 10px",
                }}
              >
                Open ↗
              </a>
            </div>

            <div
              style={{
                fontSize: 15,
                lineHeight: 1.62,
                color: "var(--text-dim)",
                whiteSpace: "pre-wrap",
                marginBottom: 20,
              }}
            >
              {item.fullText}
            </div>

            {/*
              A quote-tweet is two posts. Nesting it keeps whose words are
              whose, which a single run of text cannot do — and the quoted
              half is usually where the actual content is.
            */}
            {item.quoted && (
              <a
                href={item.quoted.url ?? item.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  border: "1px solid var(--edge)",
                  borderRadius: 10,
                  padding: 13,
                  marginBottom: 20,
                  background: "var(--card)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
                  {item.quoted.avatar ? (
                    <img
                      src={item.quoted.avatar}
                      alt=""
                      width={22}
                      height={22}
                      style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--edge-strong)" }}
                    />
                  ) : (
                    <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--edge-strong)", flexShrink: 0 }} />
                  )}
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{item.quoted.name ?? item.quoted.handle}</span>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>
                    @{item.quoted.handle ?? "unknown"}
                  </span>
                </div>

                <div style={{ fontSize: 13.5, lineHeight: 1.58, color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
                  {item.quoted.text}
                </div>

                {item.quoted.media.length > 0 && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: item.quoted.media.length === 1 ? "1fr" : "repeat(2, 1fr)",
                      gap: 6,
                      marginTop: 11,
                    }}
                  >
                    {item.quoted.media.map((m) =>
                      m.storedKey ? (
                        <img
                          key={m.originUrl}
                          src={mediaUrl(m.storedKey)}
                          alt=""
                          loading="lazy"
                          style={{
                            width: "100%",
                            display: "block",
                            borderRadius: 7,
                            border: "1px solid var(--line)",
                            background: "var(--rail)",
                          }}
                        />
                      ) : null,
                    )}
                  </div>
                )}
              </a>
            )}

            {item.media.length > 0 && (
              <Section label={item.media.length === 1 ? "Media" : `Media · ${item.media.length}`}>
                <div
                  style={{
                    display: "grid",
                    // One image gets the full width; several share a row.
                    gridTemplateColumns: item.media.length === 1 ? "1fr" : "repeat(2, 1fr)",
                    gap: 8,
                  }}
                >
                  {item.media.map((m) => (
                    <a
                      key={m.originUrl}
                      href={m.storedKey ? mediaUrl(m.storedKey) : m.originUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "block",
                        border: "1px solid var(--line)",
                        borderRadius: 6,
                        overflow: "hidden",
                        background: "var(--rail)",
                        position: "relative",
                      }}
                    >
                      {m.storedKey ? (
                        <img
                          src={mediaUrl(m.storedKey)}
                          alt=""
                          loading="lazy"
                          style={{ width: "100%", display: "block", objectFit: "cover" }}
                        />
                      ) : (
                        /* Never fetched, so there is nothing of ours to show —
                           say that rather than hot-linking the platform. */
                        <div className="mono" style={{ padding: 12, fontSize: 10.5, color: "var(--faint)" }}>
                          {m.kind} · not stored
                        </div>
                      )}
                      {m.kind === "video_poster" && m.storedKey && (
                        <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <span style={{ width: 42, height: 42, borderRadius: "50%", background: "#0b0e11b3", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--text)"><path d="M8 5v14l11-7z" /></svg>
                          </span>
                        </span>
                      )}
                    </a>
                  ))}
                </div>
              </Section>
            )}

            {item.links.length > 0 && (
              <Section label="Links in post">
                {item.links.map((href) => (
                  <a
                    key={href}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono"
                    style={{
                      display: "block",
                      fontSize: 12,
                      color: "var(--accent)",
                      padding: "9px 11px",
                      border: "1px solid var(--line)",
                      borderRadius: 5,
                      marginBottom: 6,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {href}
                  </a>
                ))}
              </Section>
            )}

            {item.thread.length > 0 && (
              <Section label={`${item.thread.length} more saved from this thread`}>
                {item.thread.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      fontSize: 12,
                      lineHeight: 1.45,
                      color: "var(--muted)",
                      paddingLeft: 9,
                      borderLeft: "1px solid var(--edge)",
                      marginBottom: 7,
                    }}
                  >
                    {t.excerpt}
                  </div>
                ))}
              </Section>
            )}

            <Section label="Metrics">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 9 }}>
                {Object.entries(item.metrics).map(([key, value]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    <span className="mono" style={{ fontSize: 15 }}>{compact(value)}</span>
                    <span style={{ fontSize: 11, color: "var(--faint)" }}>{key}</span>
                  </div>
                ))}
              </div>
            </Section>

            {/* The reason this drawer exists, per the canvas note. */}
            <Section label="Record">
              <Row k="source" v={item.source} />
              <Row k="id" v={item.id} />
              <Row
                k="saved"
                v={
                  item.savedAtExact
                    ? new Date(item.savedAt * 1000).toISOString().slice(0, 10)
                    : "import time (not exact)"
                }
              />
              <Row k="media" v={`${item.media.length} stored`} />
              <Row k="indexed" v="fts5 ✓" accent />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fainter)",
          marginBottom: 9,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div
      className="mono"
      style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, marginBottom: 5 }}
    >
      <span style={{ color: "var(--faint)" }}>{k}</span>
      <span style={{ color: accent ? "var(--ok)" : "var(--muted)" }}>{v}</span>
    </div>
  );
}
