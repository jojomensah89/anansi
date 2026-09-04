import {
  HEARTBEAT_SCHEMA_VERSION,
  type CaptureQueueStatus,
  type CaptureSource,
  type ExtensionHeartbeat,
  type HeartbeatSourceState,
} from "@anansi/sources";

const INSTALLATION_KEY = "heartbeatInstallationId";
const LAST_SUCCESS_KEY = "heartbeatLastSuccess";

export interface HeartbeatStorage {
  get(key: string): Promise<unknown>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface HeartbeatSnapshot {
  queue: CaptureQueueStatus;
  sources: Partial<Record<CaptureSource, HeartbeatSourceState>>;
}

export interface HeartbeatDependencies {
  storage: HeartbeatStorage;
  version: string;
  createId: () => string;
  now: () => number;
  readState: () => Promise<HeartbeatSnapshot>;
  transport: (heartbeat: ExtensionHeartbeat) => Promise<void>;
}

export type HeartbeatResult =
  | { ok: true; sentAt: number }
  | { ok: false; error: "unavailable" };

export interface HeartbeatClient {
  send(): Promise<HeartbeatResult>;
}

export function createHeartbeatClient(dependencies: HeartbeatDependencies): HeartbeatClient {
  const { storage, version, createId, now, readState, transport } = dependencies;
  let pending: Promise<HeartbeatResult> | null = null;

  const installationId = async (): Promise<string> => {
    const stored = await storage.get(INSTALLATION_KEY);
    if (typeof stored === "string" && stored.length > 0) return stored;
    const created = createId();
    await storage.set({ [INSTALLATION_KEY]: created });
    return created;
  };

  return {
    send() {
      if (pending) return pending;
      pending = (async () => {
        try {
          const [id, state] = await Promise.all([installationId(), readState()]);
          const heartbeat: ExtensionHeartbeat = {
            schemaVersion: HEARTBEAT_SCHEMA_VERSION,
            installationId: id,
            extensionVersion: version,
            queue: state.queue,
            sources: state.sources,
          };
          await transport(heartbeat);
          const sentAt = now();
          await storage.set({ [LAST_SUCCESS_KEY]: sentAt });
          return { ok: true, sentAt };
        } catch {
          // Heartbeat failure is diagnostic only. It must never block capture.
          return { ok: false, error: "unavailable" };
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
  };
}
