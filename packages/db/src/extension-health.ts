import type {
  CaptureQueueStatus,
  CaptureSource,
  ExtensionHeartbeat,
  HeartbeatSourceState,
} from "@anansi/sources";
import { extensionClients } from "./schema.ts";
import type { AnansiDb } from "./types.ts";

const EMPTY_QUEUE: CaptureQueueStatus = {
  queued: 0,
  uploading: 0,
  retrying: 0,
  failed: 0,
};

export interface ExtensionHealth {
  connection: "never_connected" | "connected" | "disconnected";
  extensionVersion: string | null;
  lastSeenAt: number | null;
  activeClients: number;
  queue: CaptureQueueStatus;
  sources: Partial<Record<CaptureSource, HeartbeatSourceState>>;
}

interface ClientRow {
  installationId: string;
  extensionVersion: string;
  lastSeenAt: number;
  queue: string;
  sources: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function addQueue(target: CaptureQueueStatus, value: CaptureQueueStatus): void {
  target.queued += Number(value.queued) || 0;
  target.uploading += Number(value.uploading) || 0;
  target.retrying += Number(value.retrying) || 0;
  target.failed += Number(value.failed) || 0;
}

export async function recordExtensionHeartbeat(
  db: AnansiDb,
  heartbeat: ExtensionHeartbeat,
  receivedAt: number,
): Promise<void> {
  const row = {
    installationId: heartbeat.installationId,
    extensionVersion: heartbeat.extensionVersion,
    lastSeenAt: receivedAt,
    queue: JSON.stringify(heartbeat.queue),
    sources: JSON.stringify(heartbeat.sources),
  };
  await db.insert(extensionClients).values(row).onConflictDoUpdate({
    target: extensionClients.installationId,
    set: {
      extensionVersion: row.extensionVersion,
      lastSeenAt: row.lastSeenAt,
      queue: row.queue,
      sources: row.sources,
    },
  });
}

export async function extensionHealth(
  db: AnansiDb,
  now: number,
  ttlSeconds = 300,
): Promise<ExtensionHealth> {
  const rows = (await db.select().from(extensionClients)) as ClientRow[];
  if (rows.length === 0) {
    return {
      connection: "never_connected",
      extensionVersion: null,
      lastSeenAt: null,
      activeClients: 0,
      queue: { ...EMPTY_QUEUE },
      sources: {},
    };
  }

  rows.sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt || a.installationId.localeCompare(b.installationId),
  );
  const latest = rows[0]!;
  const active = rows.filter(
    (row) => row.lastSeenAt >= now - ttlSeconds && row.lastSeenAt <= now + 60,
  );
  if (active.length === 0) {
    return {
      connection: "disconnected",
      extensionVersion: latest.extensionVersion,
      lastSeenAt: latest.lastSeenAt,
      activeClients: 0,
      queue: { ...EMPTY_QUEUE },
      sources: {},
    };
  }

  const queue = { ...EMPTY_QUEUE };
  const sources: Partial<Record<CaptureSource, HeartbeatSourceState>> = {};
  for (const row of active) {
    addQueue(queue, parseJson(row.queue, EMPTY_QUEUE));
    const state = parseJson<Partial<Record<CaptureSource, HeartbeatSourceState>>>(row.sources, {});
    for (const [source, snapshot] of Object.entries(state)) {
      if (sources[source as CaptureSource] === undefined && snapshot) {
        sources[source as CaptureSource] = snapshot;
      }
    }
  }

  return {
    connection: "connected",
    extensionVersion: active[0]!.extensionVersion,
    lastSeenAt: active[0]!.lastSeenAt,
    activeClients: active.length,
    queue,
    sources,
  };
}
