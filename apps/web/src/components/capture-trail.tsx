import type { ItemDetail } from "@anansi/db";

/** Receipts prove capture, persisted content proves storage, tags prove tagging.
 * An absent receipt is unknown, never a fabricated completed step. */
export function CaptureTrail({ item, tagging = true }: { item: ItemDetail; tagging?: boolean }) {
  const receipt = item.captureTrail;
  const failed = item.taggingState?.status === "failed";
  return <ol className="capture-trail" aria-label="Capture trail">
    <li data-state={receipt ? "done" : "missing"} title={receipt ? new Date(receipt.observedAt * 1000).toISOString() : "No capture receipt recorded"}>{receipt ? "Captured" : "Capture unrecorded"}</li>
    <li data-state="done" title={receipt ? new Date(receipt.receivedAt * 1000).toISOString() : "Persisted library record"}>Stored</li>
    {tagging && <li data-state={failed ? "error" : item.tags.length ? "done" : "missing"} title={failed ? item.taggingState?.lastError ?? "Tagging failed" : undefined}>{failed ? "Tagging failed" : item.tags.length ? "Tagged" : item.taggingState ? "Tagging pending" : "No tags"}</li>}
  </ol>;
}
