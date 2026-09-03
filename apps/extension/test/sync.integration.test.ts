import { describe, expect, test } from "bun:test";
import type { ItemEventCapture, RawPageCapture } from "@anansi/sources";
import {
  createCaptureQueue,
  type CaptureQueue,
  type OutboxStore,
} from "../lib/capture-queue.ts";
import { createIngestTransport } from "../lib/ingest-transport.ts";
import {
  ManualClock,
  MemoryOutboxStore,
  RecordingWakeScheduler,
} from "../lib/queue-test-adapters.ts";

/**
 * Delivery, interrupted.
 *
 * The unit tests cover the queue's own decisions. These cover the seam either
 * side of it: the real HTTP transport against a scripted server, and — the
 * part that actually bites — a worker that stops existing partway through.
 *
 * A Manifest V3 service worker is killed after about thirty seconds idle, and
 * can be killed mid-request. So "restart" here is not a metaphor: it builds a
 * brand new queue over the same store, which is exactly what Chrome does to
 * this extension several times an hour.
 */
const observedAt = 1_788_390_000;
const INGEST = "http://127.0.0.1:8788/api/ingest";

type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "network-error";

/** A server that answers from a script, and remembers what it was asked. */
class FakeServer {
  readonly seen: { eventId: string; token: string | null }[] = [];
  private replies: Reply[] = [];

  script(...replies: Reply[]): this {
    this.replies = replies;
    return this;
  }

  readonly fetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers as HeadersInit);
    const body = JSON.parse(String(init?.body ?? "{}")) as { eventId?: string };
    this.seen.push({
      eventId: body.eventId ?? "",
      token: headers.get("authorization"),
    });

    const reply = this.replies.shift() ?? { status: 200 };
    if (reply === "network-error") throw new TypeError("Failed to fetch");

    const payload =
      reply.body ??
      ({ eventId: body.eventId, itemId: "item-1", outcome: "created" } as const);
    return new Response(JSON.stringify(payload), {
      status: reply.status,
      headers: reply.headers,
    });
  };
}

interface Rig {
  store: OutboxStore;
  server: FakeServer;
  clock: ManualClock;
  scheduler: RecordingWakeScheduler;
  /** Everything Chrome keeps when it kills the worker: the store, and nothing else. */
  restart(): CaptureQueue;
  queue: CaptureQueue;
}

function rig(token = "ingest-token"): Rig {
  const store = new MemoryOutboxStore();
  const server = new FakeServer();
  const clock = new ManualClock(10_000);
  const scheduler = new RecordingWakeScheduler();
  let current = token;

  const build = () =>
    createCaptureQueue(
      {
        store,
        transport: createIngestTransport(
          async () => ({ ingest: INGEST, token: current }),
          server.fetch,
          () => clock.now(),
        ),
        clock,
        random: () => 0.5,
        scheduler,
      },
      { baseRetryMs: 1_000, maxRetryMs: 60_000 },
    );

  const self: Rig = {
    store,
    server,
    clock,
    scheduler,
    queue: build(),
    restart: () => {
      self.queue = build();
      return self.queue;
    },
  };
  // Exposed only so the token-rotation case can move it.
  Object.defineProperty(self, "token", {
    set(value: string) {
      current = value;
    },
  });
  return self;
}

/**
 * Enqueue, then wake — the pair the background worker always performs.
 *
 * `enqueue` deliberately only commits: the record is durable before anything
 * is attempted, and the drain is a separate wake. Tests that skip the wake are
 * testing a state the extension never sits in.
 */
const push = async (r: Rig, capture: ItemEventCapture | RawPageCapture) => {
  await r.queue.enqueue(capture);
  await r.queue.retry();
};

const save = (eventId: string, source: "x" | "reddit" = "x"): ItemEventCapture => ({
  schemaVersion: 1,
  payloadType: "item_event",
  eventId,
  source,
  action: "save",
  externalId: `${source}-${eventId}`,
  canonicalUrl: `https://${source}.example/${eventId}`,
  observedAt,
  captureMethod: "platform_event",
  normalizedItem: {
    source,
    externalId: `${source}-${eventId}`,
    url: `https://${source}.example/${eventId}`,
    kind: "post",
    body: `saved ${eventId}`,
    savedAt: observedAt,
    savedAtIsExact: true,
    metrics: {},
    media: [],
    links: [],
    raw: {},
  },
});

const page = (eventId: string, pageNumber: number): RawPageCapture => ({
  schemaVersion: 1,
  payloadType: "raw_page",
  eventId,
  source: "x",
  action: "snapshot",
  observedAt,
  captureMethod: "platform_import",
  runId: "run-1",
  page: pageNumber,
  raw: { entries: [{ id: pageNumber }] },
});

/* ------------------------------------------------------- the server ---- */

describe("the server is not there", () => {
  test("an offline save is kept, and goes out when the server returns", async () => {
    const r = rig();
    r.server.script("network-error", { status: 200 });

    await push(r, save("a"));
    expect((await r.store.list())[0]?.state).toBe("retry_wait");

    // The alarm the queue asked for, fired.
    r.clock.set(r.scheduler.times.at(-1) ?? 20_000);
    await r.queue.retry();

    expect(await r.store.list()).toEqual([]);
    expect(r.server.seen.length).toBe(2);
  });

  test("nothing is lost while it is away, however many attempts fail", async () => {
    const r = rig();
    r.server.script("network-error", "network-error", "network-error");

    await push(r, save("a"));
    for (const _ of [1, 2]) {
      r.clock.set(r.clock.now() + 120_000);
      await r.queue.retry();
    }

    const [record] = await r.store.list();
    expect(record?.state).toBe("retry_wait");
    expect(record?.attempts).toBe(3);
    expect(record?.capture.eventId).toBe("a");
  });
});

/* ------------------------------------------------- the worker dies ----- */

describe("the worker stops existing", () => {
  test("killed after the commit, before the request: nothing was sent, nothing lost", async () => {
    const r = rig();
    // No transport call at all — enqueue commits first, and the worker dies
    // before the drain gets anywhere.
    const store = new MemoryOutboxStore();
    const queue = createCaptureQueue({
      store,
      transport: {
        async send() {
          throw new Error("worker died before this could run");
        },
      },
      clock: r.clock,
      random: () => 0.5,
      scheduler: r.scheduler,
    });

    await queue.enqueue(save("a")).catch(() => undefined);
    const survived = await store.list();
    expect(survived.length).toBe(1);
    expect(survived[0]?.capture.eventId).toBe("a");
  });

  test("killed mid-request: the abandoned record is recovered and delivered", async () => {
    const r = rig();

    // Leave it exactly as a kill during upload leaves it.
    await r.queue.enqueue(save("a")).catch(() => undefined);
    const [inflight] = await r.store.list();
    await r.store.put({ ...(inflight as never), state: "uploading" });

    r.server.script({ status: 200 });
    const revived = r.restart();
    await revived.retry();

    expect(await r.store.list()).toEqual([]);
  });

  test("killed after the server committed: the replay is one item, not two", async () => {
    const r = rig();
    // The first attempt reached the server and came back as a dropped
    // connection, so the record is still here. The server has already applied
    // it, and says so with `duplicate` on the replay.
    r.server.script("network-error", {
      status: 200,
      body: { eventId: "a", itemId: "item-1", outcome: "duplicate" },
    });

    await push(r, save("a"));
    r.clock.set(r.clock.now() + 120_000);
    await r.restart().retry();

    expect(await r.store.list()).toEqual([]);
    expect(r.server.seen.map((s) => s.eventId)).toEqual(["a", "a"]);
  });

  test("a restart mid-import delivers every page exactly once", async () => {
    const r = rig();
    r.server.script("network-error", "network-error", "network-error");

    await r.queue.enqueue(page("run-1:page:1", 1));
    await r.queue.enqueue(page("run-1:page:2", 2));
    await r.queue.enqueue(page("run-1:page:3", 3));
    await r.queue.retry();
    expect((await r.store.list()).length).toBe(3);

    r.server.script({ status: 200 }, { status: 200 }, { status: 200 });
    r.clock.set(r.clock.now() + 120_000);
    await r.restart().retry();

    expect(await r.store.list()).toEqual([]);
    const delivered = r.server.seen.slice(3).map((s) => s.eventId).sort();
    expect(delivered).toEqual(["run-1:page:1", "run-1:page:2", "run-1:page:3"]);
  });
});

/* ------------------------------------------------ what HTTP says ------- */

describe("the server says wait", () => {
  test("Retry-After is honoured over the backoff", async () => {
    const r = rig();
    r.server.script({ status: 429, headers: { "retry-after": "45" } });

    await push(r, save("a"));

    const [record] = await r.store.list();
    expect(record?.state).toBe("retry_wait");
    // 45s, not the 1s base backoff this attempt would otherwise have taken.
    expect((record?.nextAttemptAt ?? 0) - 10_000).toBe(45_000);
  });

  test("a 429 with no header still backs off rather than spinning", async () => {
    const r = rig();
    r.server.script({ status: 429 });

    await push(r, save("a"));

    const [record] = await r.store.list();
    expect(record?.state).toBe("retry_wait");
    expect(record?.nextAttemptAt).toBeGreaterThan(10_000);
    expect(r.server.seen.length).toBe(1);
  });

  test("a 500 is retried; the record is not thrown away", async () => {
    const r = rig();
    r.server.script({ status: 500 }, { status: 200 });

    await push(r, save("a"));
    expect((await r.store.list())[0]?.state).toBe("retry_wait");

    r.clock.set(r.clock.now() + 120_000);
    await r.queue.retry();
    expect(await r.store.list()).toEqual([]);
  });
});

describe("the server says no", () => {
  test("401 after a token rotation fails visibly instead of spinning", async () => {
    const r = rig("old-token");
    r.server.script({ status: 401 }, { status: 401 });

    await push(r, save("a"));

    const [failed] = await r.store.list();
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError?.status).toBe(401);

    // An ordinary wake must not touch a permanently failed record.
    r.clock.set(r.clock.now() + 600_000);
    await r.queue.retry();
    expect(r.server.seen.length).toBe(1);
  });

  test("the new token is used once the failure is retried deliberately", async () => {
    const r = rig("old-token");
    r.server.script({ status: 401 }, { status: 200 });

    await push(r, save("a"));
    (r as unknown as { token: string }).token = "new-token";
    await r.queue.retry({ includeFailed: true });

    expect(await r.store.list()).toEqual([]);
    expect(r.server.seen.map((s) => s.token)).toEqual([
      "Bearer old-token",
      "Bearer new-token",
    ]);
  });

  test("422 after a parser change is a visible failure, not a retry loop", async () => {
    const r = rig();
    r.server.script({ status: 422 });

    await push(r, page("run-1:page:1", 1));

    const [record] = await r.store.list();
    expect(record?.state).toBe("failed");
    expect(record?.lastError?.status).toBe(422);
    // Still here: a 422 must not silently discard the capture.
    expect(record?.capture.eventId).toBe("run-1:page:1");
  });

  test("a 200 that is not a receipt is a mismatch, not a retry", async () => {
    const r = rig();
    r.server.script({ status: 200, body: { ok: true } });

    await push(r, save("a"));

    // Retrying cannot fix a server that does not speak this protocol, so this
    // fails where someone can see it rather than spinning quietly forever.
    const [record] = await r.store.list();
    expect(record?.state).toBe("failed");
    expect(record?.lastError?.code).toBe("invalid_receipt");
  });

  test("a receipt for someone else's event does not acknowledge this one", async () => {
    const r = rig();
    r.server.script({
      status: 200,
      body: { eventId: "some-other-event", itemId: "item-9", outcome: "created" },
    });

    await push(r, save("a"));

    // The capture is still here. Deleting on a mismatched receipt is how a
    // save disappears without ever having been stored.
    const [record] = await r.store.list();
    expect(record?.capture.eventId).toBe("a");
    expect(record?.state).toBe("failed");
  });
});

/* ------------------------------------------------------- pressure ------ */

describe("under pressure", () => {
  test("two sources drain together without either being dropped", async () => {
    const r = rig();
    r.server.script({ status: 200 }, { status: 200 }, { status: 200 }, { status: 200 });

    await Promise.all([
      r.queue.enqueue(save("x-1", "x")),
      r.queue.enqueue(save("r-1", "reddit")),
      r.queue.enqueue(save("x-2", "x")),
      r.queue.enqueue(save("r-2", "reddit")),
    ]);
    await r.queue.retry();

    expect(await r.store.list()).toEqual([]);
    expect(r.server.seen.map((s) => s.eventId).sort()).toEqual([
      "r-1",
      "r-2",
      "x-1",
      "x-2",
    ]);
  });

  test("an oversized capture sheds its raw payload rather than being refused", async () => {
    const r = rig();
    r.server.script({ status: 200 });

    const big = save("a");
    const bulky = {
      ...big,
      normalizedItem: { ...big.normalizedItem!, raw: { blob: "x".repeat(40_000) } },
    };
    await push(r, bulky);

    const sent = r.server.seen.length;
    expect(sent).toBe(1);
    expect(await r.store.list()).toEqual([]);
  });

  test("the same capture enqueued twice is one record and one delivery", async () => {
    const r = rig();
    r.server.script({ status: 200 });

    await r.queue.enqueue(save("a"));
    await r.queue.enqueue(save("a"));
    await r.queue.retry();

    expect(r.server.seen.length).toBe(1);
    expect(await r.store.list()).toEqual([]);
  });

  test("status counts come from the store, so a restart does not forget them", async () => {
    const r = rig();
    r.server.script({ status: 422 }, "network-error");

    await r.queue.enqueue(page("run-1:page:1", 1));
    await r.queue.enqueue(save("a"));
    await r.queue.retry();

    const after = await r.restart().getStatus();
    expect(after.failed).toBe(1);
    expect(after.retrying + after.queued).toBe(1);
  });
});
