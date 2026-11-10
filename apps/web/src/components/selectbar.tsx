import { Input } from "@anansi/ui/components/input";
import { Button } from "@anansi/ui/components/button";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";

/**
 * The bulk action bar.
 *
 * Exists only while something is selected, floating over the grid rather than
 * taking a permanent strip of chrome for a mode nobody is usually in.
 *
 * Archive is a flag, not a delete. A deleted row comes straight back on the
 * next import, so the only thing that can persist "I am done with this" is
 * something the importer preserves.
 */
export function SelectBar({
  ids,
  loaded,
  archived,
  onClear,
  onSelectAll,
  onDone,
}: {
  ids: string[];
  loaded: number;
  archived: boolean;
  onClear: () => void;
  onSelectAll: () => void;
  onDone: () => void;
}) {
  const [tagging, setTagging] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<{ label: string; color: string; count: number }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!tagging) return;
    input.current?.focus();
    api.tags().then((t) => setTags(t.tags.slice(0, 8))).catch(() => {});
  }, [tagging]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch {
      setBusy(false);
    }
  };

  const applyTag = (value: string) => {
    const clean = value.trim();
    if (!clean) return;
    void run(() => api.tag(ids, clean));
  };

  return (
    <div className="workspace-bulk"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        animation: "rise 140ms var(--ease-ui) both",
      }}
    >
      {tagging && (
        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--edge-strong)",
            borderRadius: 8,
            padding: 12,
            boxShadow: "0 18px 44px -14px #000000cc",
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          <Input
            ref={input}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyTag(label);
              if (e.key === "Escape") setTagging(false);
            }}
            placeholder={`Tag ${ids.length} item${ids.length === 1 ? "" : "s"}`}
            style={{
              height: 32,
              width: 300,
              padding: "0 10px",
              background: "var(--card)",
              border: "1px solid var(--edge)",
              borderRadius: 5,
              color: "var(--text)",
              fontSize: "var(--text-body)",
              outline: "none",
            }}
          />
          {tags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 300 }}>
              {tags.map((t) => (
                <Button variant="ghost"
                  key={t.label}
                  type="button"
                  onClick={() => applyTag(t.label)}
                  style={{
                    display: "flex",
                    gap: 6,
                    fontSize: "var(--text-body)",
                    padding: "4px 8px",
                    borderRadius: 4,
                    background: "transparent",
                    border: "1px solid var(--line)",
                    color: "var(--muted)",
                    cursor: "pointer",
                  }}
                >
                  {t.label}
                  <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{t.count}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 14px",
          borderRadius: 8,
          background: "var(--card)",
          border: "1px solid var(--edge-strong)",
          boxShadow: "0 18px 44px -14px #000000cc",
        }}
      >
        <span role="status" style={{ fontSize: "var(--text-body)", color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
          {ids.length} selected
        </span>
        <Button variant="ghost"
          type="button"
          onClick={onSelectAll}
          aria-label={`Select all ${loaded} loaded items`}
          style={{ fontSize: "var(--text-body)", color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}
        >
          Select all {loaded}
        </Button>

        <div style={{ display: "flex", gap: 7, marginLeft: 14 }}>
          <Action label="Tag" onClick={() => setTagging((t) => !t)} busy={busy} />
          <Action
            label={archived ? "Restore" : "Archive"}
            onClick={() => void run(() => api.archive(ids, !archived))}
            busy={busy}
          />
          <Action
            label="Copy links"
            onClick={() => {
              // Reading the urls back costs nothing next to the round trip
              // saved by not holding every selected row in memory.
              void api
                .items({ limit: 200 })
                .then((p) =>
                  navigator.clipboard.writeText(
                    p.items.filter((i) => ids.includes(i.id)).map((i) => i.url).join("\n"),
                  ),
                )
                .then(onClear);
            }}
            busy={busy}
          />
          <Button variant="ghost"
            type="button"
            onClick={onClear}
            aria-keyshortcuts="Escape"
            style={{
              height: 30,
              padding: "0 10px",
              borderRadius: 5,
              border: "1px solid var(--line)",
              background: "transparent",
              color: "var(--muted)",
              fontSize: "var(--text-body)",
              cursor: "pointer",
            }}
          >
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

function Action({ label, onClick, busy }: { label: string; onClick: () => void; busy: boolean }) {
  return (
    <Button variant="ghost"
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        display: "flex",
        alignItems: "center",
        height: 30,
        padding: "0 12px",
        borderRadius: 5,
        border: "1px solid var(--edge)",
        background: "var(--card)",
        color: busy ? "var(--faint)" : "var(--text-dim)",
        fontSize: "var(--text-body)",
        cursor: busy ? "wait" : "pointer",
        font: "inherit",
      }}
    >
      {label}
    </Button>
  );
}
