import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { api, type Collection } from "../lib/api.ts";
import { libraryKeys } from "../lib/library-query.ts";
import { SavedViewsSkeleton, useSlowLoad } from "./skeleton.tsx";

export function LibraryActions({ current, onApply }: {
  current: Collection["filters"];
  onApply: (collection: Collection) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [exporting, setExporting] = useState(false);
  const collections = useQuery({
    queryKey: libraryKeys.collections(),
    queryFn: ({ signal }) => api.collections(signal),
    staleTime: 30_000,
  });
  const collectionsSlow = useSlowLoad(collections.isPending);
  const save = useMutation({
    mutationFn: () => api.saveCollection(name.trim(), current),
    onSuccess: ({ collection }) => {
      queryClient.setQueryData<{ collections: Collection[] }>(libraryKeys.collections(), (old) => ({
        collections: [...(old?.collections ?? []).filter((entry) => entry.id !== collection.id), collection],
      }));
      setName("");
      toast.success(`Saved “${collection.name}”`);
    },
    onError: (error) => toast.error("Could not save this view", { description: message(error) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCollection(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<{ collections: Collection[] }>(libraryKeys.collections(), (old) => ({
        collections: (old?.collections ?? []).filter((entry) => entry.id !== id),
      }));
      toast.success("Saved view removed");
    },
    onError: (error) => toast.error("Could not remove this view", { description: message(error) }),
  });
  const update = useMutation({
    mutationFn: (collection: Collection) => api.saveCollection(collection.name, current, collection.id),
    onSuccess: ({ collection }) => {
      queryClient.setQueryData<{ collections: Collection[] }>(libraryKeys.collections(), (old) => ({
        collections: (old?.collections ?? []).map((entry) => entry.id === collection.id ? collection : entry),
      }));
      toast.success(`Updated “${collection.name}”`);
    },
    onError: (error) => toast.error("Could not update this view", { description: message(error) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) save.mutate();
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      const blob = await api.exportLibrary();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `anansi-library-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(href);
      toast.success("Library export downloaded");
    } catch (error) {
      toast.error("Export failed", { description: message(error) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <details style={{ position: "relative" }}>
      <summary style={summaryStyle}>Saved views</summary>
      <div style={{ position: "absolute", right: 0, top: 36, zIndex: 70, width: 310, padding: 10, border: "1px solid var(--edge-strong)", borderRadius: 8, background: "var(--card)", boxShadow: "0 16px 40px #0009" }}>
        <div className="mono" style={{ fontSize: 10, color: "var(--faint)", margin: "2px 3px 8px" }}>A saved view remembers these filters</div>
        {collections.isPending && collectionsSlow && <SavedViewsSkeleton />}
        {collections.isError && <div role="alert" style={{ ...statusStyle, color: "#f2a7a7" }}>{message(collections.error)} <button type="button" onClick={() => void collections.refetch()} style={linkStyle}>Retry</button></div>}
        {collections.data?.collections.map((collection) => (
          <div key={collection.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 3px", borderBottom: "1px solid var(--line-soft)" }}>
            <button type="button" onClick={() => onApply(collection)} style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", textAlign: "left", font: "inherit", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{collection.name}</button>
            <button type="button" aria-label={`Update ${collection.name} with current filters`} onClick={() => update.mutate(collection)} disabled={update.isPending} style={linkStyle}>Update</button>
            <button type="button" aria-label={`Delete ${collection.name}`} onClick={() => remove.mutate(collection.id)} disabled={remove.isPending} style={linkStyle}>Delete</button>
          </div>
        ))}
        {collections.data?.collections.length === 0 && <div style={statusStyle}>No saved views yet.</div>}
        <form onSubmit={submit} style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <label htmlFor="collection-name" className="sr-only">Saved view name</label>
          <input id="collection-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name this view" maxLength={80} style={{ flex: 1, minWidth: 0, height: 30, borderRadius: 5, border: "1px solid var(--edge)", background: "var(--ink)", color: "var(--text)", padding: "0 8px", font: "inherit", fontSize: 12 }} />
          <button type="submit" disabled={!name.trim() || save.isPending} style={smallButton}>Save</button>
        </form>
        <button type="button" disabled={exporting} onClick={() => void exportAll()} style={{ ...smallButton, width: "100%", marginTop: 8, background: "transparent", color: "var(--muted)" }}>{exporting ? "Preparing export…" : "Download full library export"}</button>
      </div>
    </details>
  );
}

const summaryStyle = { display: "flex", alignItems: "center", height: 30, padding: "0 11px", borderRadius: 5, border: "1px solid var(--edge)", background: "var(--card)", color: "var(--text-dim)", cursor: "pointer", fontSize: 12.5, listStyle: "none" } as const;
const smallButton = { height: 30, padding: "0 9px", borderRadius: 5, border: "1px solid var(--edge)", background: "var(--raised)", color: "var(--text)", cursor: "pointer", font: "inherit", fontSize: 11.5 } as const;
const linkStyle = { border: "none", background: "transparent", color: "var(--faint)", cursor: "pointer", font: "inherit", fontSize: 10.5 } as const;
const statusStyle = { padding: "8px 3px", color: "var(--faint)", fontSize: 11.5 } as const;
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
