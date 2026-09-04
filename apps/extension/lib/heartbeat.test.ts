import { describe, expect, test } from "bun:test";
import { createHeartbeatClient } from "./heartbeat.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";

function harness(options: { fail?: boolean } = {}) {
  const values = new Map<string, unknown>();
  const sent: unknown[] = [];
  let ids = 0;
  let reads = 0;
  const client = createHeartbeatClient({
    storage: {
      get: async (key) => values.get(key),
      set: async (next) => {
        for (const [key, value] of Object.entries(next)) values.set(key, value);
      },
    },
    version: "0.1.0",
    createId: () => {
      ids++;
      return ID;
    },
    now: () => 1_000,
    readState: async () => {
      reads++;
      return {
        queue: { queued: 1, uploading: 0, retrying: 0, failed: 0 },
        sources: {
          x: {
            phase: "idle" as const,
            queued: 1,
            uploading: 0,
            retrying: 0,
            failed: 0,
          },
        },
      };
    },
    transport: async (heartbeat) => {
      if (options.fail) throw new Error("Bearer secret at https://server.test/private");
      sent.push(heartbeat);
    },
  });
  return { client, values, sent, counts: () => ({ ids, reads }) };
}

describe("HeartbeatClient", () => {
  test("creates one installation id and reuses it", async () => {
    const h = harness();
    await h.client.send();
    await h.client.send();
    expect(h.counts().ids).toBe(1);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ installationId: ID, extensionVersion: "0.1.0" });
  });

  test("coalesces concurrent sends", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.client.send(), h.client.send()]);
    expect(first).toEqual(second);
    expect(h.counts().reads).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  test("stores success time without leaking configuration or content", async () => {
    const h = harness();
    expect(await h.client.send()).toEqual({ ok: true, sentAt: 1_000 });
    const serialized = JSON.stringify(h.sent[0]);
    for (const forbidden of ["token", "server", "url", "raw", "cookie", "authorization"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    expect(h.values.get("heartbeatLastSuccess")).toBe(1_000);
  });

  test("returns a fixed diagnostic when transport fails", async () => {
    const h = harness({ fail: true });
    const result = await h.client.send();
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(h.values.has("heartbeatLastSuccess")).toBe(false);
  });
});
