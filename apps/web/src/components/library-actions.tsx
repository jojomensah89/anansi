import { Input } from "@anansi/ui/components/input";
import { Popover, PopoverTrigger, PopoverContent } from "@anansi/ui/components/popover";
import { Button } from "@anansi/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { api, type Collection } from "../lib/api.ts";
import { libraryKeys } from "../lib/library-query.ts";
import { restoreLibraryFile } from "../lib/restore-library.ts";
import { SavedViewsSkeleton, useSlowLoad } from "./skeleton.tsx";

export function LibraryActions({ current, onApply }: {
  current: Collection["filters"];
  onApply: (collection: Collection) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<string | null>(null);
  const [abandonableBackupId, setAbandonableBackupId] = useState<string | null>(null);
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

  const restoreFile = async (file: File) => {
    setRestoring(true);
    setRestoreProgress("Checking export…");
    setAbandonableBackupId(null);
    try {
      await restoreLibraryFile(file, setRestoreProgress);
      await queryClient.invalidateQueries();
      toast.success("Library data restored");
    } catch (error) {
      setRestoreProgress(message(error));
      toast.error("Restore stopped", { description: message(error) });
      try {
        const { restore } = await api.restoreStatus();
        if (restore?.status === "active" && Object.values(restore.progress).every((count) => count === 0)) {
          setAbandonableBackupId(restore.backupId);
        }
      } catch { /* Keep the original restore error. */ }
    } finally { setRestoring(false); }
  };

  return (
    <Popover>
      <PopoverTrigger style={summaryStyle}>Saved views</PopoverTrigger>
      <PopoverContent align="end" style={{width:310,padding:10}}>
        {collections.isPending && collectionsSlow && <SavedViewsSkeleton />}
        {collections.isError && <div role="alert" style={{ ...statusStyle, color: "var(--danger)" }}>{message(collections.error)} <Button variant="ghost" type="button" onClick={() => void collections.refetch()} style={linkStyle}>Retry</Button></div>}
        {collections.data?.collections.map((collection) => (
          <div key={collection.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 3px", borderBottom: "1px solid var(--line-soft)" }}>
            <Button variant="ghost" type="button" onClick={() => onApply(collection)} style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", textAlign: "left", font: "inherit", fontSize: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{collection.name}</Button>
            <Button variant="ghost" type="button" aria-label={`Update ${collection.name} with current filters`} onClick={() => update.mutate(collection)} disabled={update.isPending} style={linkStyle}>Update</Button>
            <Button variant="ghost" type="button" aria-label={`Delete ${collection.name}`} onClick={() => remove.mutate(collection.id)} disabled={remove.isPending} style={linkStyle}>Delete</Button>
          </div>
        ))}
        {collections.data?.collections.length === 0 && <div style={statusStyle}>No saved views</div>}
        <form onSubmit={submit} style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <label htmlFor="collection-name" className="sr-only">Saved view name</label>
          <Input id="collection-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name this view" maxLength={80} style={{ flex: 1, minWidth: 0, height: 30, borderRadius: 5, border: "1px solid var(--edge)", background: "var(--ink)", color: "var(--text)", padding: "0 8px", font: "inherit", fontSize: "var(--text-body)" }} />
          <Button variant="ghost" type="submit" disabled={!name.trim() || save.isPending} style={smallButton}>Save</Button>
        </form>
        <Button variant="ghost" type="button" disabled={exporting} onClick={() => void exportAll()} style={{ ...smallButton, width: "100%", marginTop: 8, background: "transparent", color: "var(--muted)" }}>{exporting ? "Preparing export…" : "Export library (without media)"}</Button>
        <label style={{ ...smallButton, display: "block", textAlign: "center", marginTop: 8, cursor: restoring ? "wait" : "pointer" }}>
          {restoring ? "Restoring…" : "Restore into an empty library"}
          <Input type="file" accept=".json,application/json" disabled={restoring} style={{ display: "none" }} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void restoreFile(file);
          }} />
        </label>
        {restoreProgress && <p role="status" style={{ ...statusStyle, lineHeight: 1.5 }}>{restoreProgress}</p>}
        {abandonableBackupId && <Button variant="ghost" type="button" style={{ ...smallButton, width: "100%" }} onClick={() => {
          void api.restoreAbort(abandonableBackupId).then(() => {
            setAbandonableBackupId(null);
            setRestoreProgress("Empty restore session cleared. Choose a corrected export.");
          }).catch((error) => toast.error("Could not clear restore session", { description: message(error) }));
        }}>Clear empty restore session</Button>}
      </PopoverContent>
    </Popover>
  );
}

const summaryStyle = { display: "flex", alignItems: "center", height: 32, padding: "0 12px", borderRadius: 6, border: "1px solid var(--edge)", background: "var(--card)", color: "var(--text-dim)", cursor: "pointer", fontSize: "var(--text-body)", listStyle: "none" } as const;
const smallButton = { height: 30, padding: "0 9px", borderRadius: 5, border: "1px solid var(--edge)", background: "var(--raised)", color: "var(--text)", cursor: "pointer", font: "inherit", fontSize: "var(--text-body)" } as const;
const linkStyle = { border: "none", background: "transparent", color: "var(--faint)", cursor: "pointer", font: "inherit", fontSize: "var(--text-body)" } as const;
const statusStyle = { padding: "8px 3px", color: "var(--faint)", fontSize: "var(--text-body)" } as const;
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
