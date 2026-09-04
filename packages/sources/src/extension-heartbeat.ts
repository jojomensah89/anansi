import type { CaptureQueueStatus, CaptureSource } from "./capture.ts";

export const HEARTBEAT_SCHEMA_VERSION = 1 as const;

export interface HeartbeatSourceState extends CaptureQueueStatus {
  phase: "idle" | "running";
  paused?: boolean;
  lastErrorCode?: string;
}

export interface ExtensionHeartbeat {
  schemaVersion: typeof HEARTBEAT_SCHEMA_VERSION;
  installationId: string;
  extensionVersion: string;
  queue: CaptureQueueStatus;
  sources: Partial<Record<CaptureSource, HeartbeatSourceState>>;
}

export interface HeartbeatValidationError {
  code: "invalid_heartbeat" | "unsupported_version";
  message: string;
}

export type HeartbeatParseResult =
  | { ok: true; heartbeat: ExtensionHeartbeat }
  | { ok: false; error: HeartbeatValidationError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,49}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SOURCES = new Set<CaptureSource>(["x", "reddit", "tiktok", "web"]);
const ROOT_KEYS = new Set(["schemaVersion", "installationId", "extensionVersion", "queue", "sources"]);
const QUEUE_KEYS = new Set(["queued", "uploading", "retrying", "failed"]);
const SOURCE_KEYS = new Set([...QUEUE_KEYS, "phase", "paused", "lastErrorCode"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function queue(value: unknown): value is CaptureQueueStatus {
  return (
    record(value) &&
    exactKeys(value, QUEUE_KEYS) &&
    count(value.queued) &&
    count(value.uploading) &&
    count(value.retrying) &&
    count(value.failed)
  );
}

function sourceState(value: unknown): value is HeartbeatSourceState {
  return (
    record(value) &&
    exactKeys(value, SOURCE_KEYS) &&
    queue({
      queued: value.queued,
      uploading: value.uploading,
      retrying: value.retrying,
      failed: value.failed,
    }) &&
    (value.phase === "idle" || value.phase === "running") &&
    (value.paused === undefined || typeof value.paused === "boolean") &&
    (value.lastErrorCode === undefined ||
      (typeof value.lastErrorCode === "string" && ERROR_CODE.test(value.lastErrorCode)))
  );
}

function fail(
  code: HeartbeatValidationError["code"],
  message: string,
): HeartbeatParseResult {
  return { ok: false, error: { code, message } };
}

/** Strict, bounded validation. Errors never echo the supplied payload. */
export function parseExtensionHeartbeat(value: unknown): HeartbeatParseResult {
  if (!record(value) || !exactKeys(value, ROOT_KEYS)) {
    return fail("invalid_heartbeat", "heartbeat shape is invalid");
  }
  if (value.schemaVersion !== HEARTBEAT_SCHEMA_VERSION) {
    return fail("unsupported_version", "heartbeat schema version is unsupported");
  }
  if (typeof value.installationId !== "string" || !UUID.test(value.installationId)) {
    return fail("invalid_heartbeat", "installation id is invalid");
  }
  if (typeof value.extensionVersion !== "string" || !VERSION.test(value.extensionVersion)) {
    return fail("invalid_heartbeat", "extension version is invalid");
  }
  if (!queue(value.queue) || !record(value.sources) || Object.keys(value.sources).length > 4) {
    return fail("invalid_heartbeat", "heartbeat state is invalid");
  }
  for (const [source, state] of Object.entries(value.sources)) {
    if (!SOURCES.has(source as CaptureSource) || !sourceState(state)) {
      return fail("invalid_heartbeat", "source heartbeat state is invalid");
    }
  }
  return { ok: true, heartbeat: value as unknown as ExtensionHeartbeat };
}
