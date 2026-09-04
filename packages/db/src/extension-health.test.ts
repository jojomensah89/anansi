import { describe, expect, test } from "bun:test";
import type { ExtensionHeartbeat } from "@anansi/sources";
import { extensionHealth, recordExtensionHeartbeat } from "./extension-health.ts";
import { openTestDb } from "./test-db.ts";

const heartbeat = (
  installationId: string,
  queued = 0,
  extensionVersion = "0.1.0",
): ExtensionHeartbeat => ({
  schemaVersion: 1,
  installationId,
  extensionVersion,
  queue: { queued, uploading: 0, retrying: 0, failed: 0 },
  sources: {
    x: {
      phase: queued ? "running" : "idle",
      queued,
      uploading: 0,
      retrying: 0,
      failed: 0,
    },
  },
});

const A = "123e4567-e89b-42d3-a456-426614174000";
const B = "123e4567-e89b-42d3-b456-426614174001";

describe("extensionHealth", () => {
  test("distinguishes never connected, connected, and disconnected", async () => {
    const db = openTestDb();
    expect(await extensionHealth(db, 1_000)).toMatchObject({
      connection: "never_connected",
      lastSeenAt: null,
    });

    await recordExtensionHeartbeat(db, heartbeat(A), 900);
    expect(await extensionHealth(db, 1_000)).toMatchObject({
      connection: "connected",
      extensionVersion: "0.1.0",
      lastSeenAt: 900,
      activeClients: 1,
    });
    expect(await extensionHealth(db, 1_201)).toMatchObject({
      connection: "disconnected",
      lastSeenAt: 900,
      activeClients: 0,
    });
  });

  test("upserts one installation using server receipt time", async () => {
    const db = openTestDb();
    await recordExtensionHeartbeat(db, heartbeat(A, 1), 900);
    await recordExtensionHeartbeat(db, heartbeat(A, 4, "0.2.0"), 950);

    expect(await extensionHealth(db, 1_000)).toMatchObject({
      extensionVersion: "0.2.0",
      lastSeenAt: 950,
      activeClients: 1,
      queue: { queued: 4 },
    });
  });

  test("aggregates active clients and takes the newest source snapshot", async () => {
    const db = openTestDb();
    await recordExtensionHeartbeat(db, heartbeat(A, 2, "0.1.0"), 900);
    await recordExtensionHeartbeat(db, heartbeat(B, 3, "0.2.0"), 950);

    const health = await extensionHealth(db, 1_000);
    expect(health).toMatchObject({
      connection: "connected",
      extensionVersion: "0.2.0",
      lastSeenAt: 950,
      activeClients: 2,
      queue: { queued: 5 },
    });
    expect(health.sources.x?.queued).toBe(3);
  });
});
