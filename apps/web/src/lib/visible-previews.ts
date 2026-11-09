const requested = new Set<string>();
const pending = new Map<string, () => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
export function requestVisiblePreview(id: string, changed: () => void) {
  if (requested.has(id)) return;
  requested.add(id);
  pending.set(id, changed);
  if (!timer && !running) timer = setTimeout(drain, 250);
}
async function drain() {
  timer = undefined; running = true;
  try {
    while (pending.size) {
      const [id, changed] = pending.entries().next().value!;
      pending.delete(id);
      try {
        const response = await fetch("/api/link-previews/visible", {method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({ids:[id]})});
        if (response.ok) changed();
      } catch { /* Durable cron retries remain authoritative. */ }
    }
  } finally { running = false; }
}
