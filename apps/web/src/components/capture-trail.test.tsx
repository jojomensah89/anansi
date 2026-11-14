import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemDetail } from "@anansi/db";
import { CaptureTrail } from "./capture-trail";

test("capture trail distinguishes missing evidence and persisted records", () => {
  const html = renderToStaticMarkup(<CaptureTrail item={{ tags: [] } as unknown as ItemDetail} />);
  expect(html).toContain("Capture unrecorded");
  expect(html).toContain("Stored");
  expect(html).toContain("No tags");
});
test("capture trail uses durable receipts and exposes tagging failures", () => {
  const html = renderToStaticMarkup(<CaptureTrail item={{ tags: [], captureTrail: { observedAt: 1, receivedAt: 2, outcome: "created" }, taggingState: { status: "failed", lastError: "ai:provider-unavailable" } } as unknown as ItemDetail} />);
  expect(html).toContain("Captured");
  expect(html).toContain("Tagging failed");
  expect(html).toContain("ai:provider-unavailable");
});
