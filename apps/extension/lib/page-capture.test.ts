import { describe, expect, test } from "bun:test";
import {
  capturablePage,
  safeAsset,
  toWebCapture,
  type PageDetails,
} from "./page-capture.ts";

const now = 1_788_390_000;

const details = (patch: Partial<PageDetails> = {}): PageDetails => ({
  url: "https://example.dev/posts/keyset-pagination?utm_source=newsletter#intro",
  title: "Keyset pagination, properly",
  canonical: "/posts/keyset-pagination",
  description: "Why offset paging drops rows when the set changes underneath.",
  image: "/og/keyset.png",
  siteName: "Example Dev",
  favicon: "/favicon.ico",
  selection: null,
  text: "Offset pagination silently drops or repeats items whenever the set changes.",
  ...patch,
});

const captured = async (patch: Partial<PageDetails> = {}, method: "toolbar" | "context_menu" = "toolbar") => {
  const result = await toWebCapture(details(patch), { method, observedAt: now });
  if (!result.ok) throw new Error(`expected a capture, got ${result.reason}`);
  return result.capture;
};

describe("capturablePage", () => {
  test("http and https are savable", () => {
    expect(capturablePage("https://example.dev/a")).toEqual({
      ok: true,
      url: "https://example.dev/a",
    });
    expect(capturablePage("http://localhost:3000/a").ok).toBe(true);
  });

  test("browser pages are named, not failed on", () => {
    for (const url of [
      "chrome://extensions",
      "about:blank",
      "chrome-extension://abc/popup.html",
      "moz-extension://abc/popup.html",
      "view-source:https://example.dev",
      "devtools://devtools/bundled/inspector.html",
    ]) {
      expect(capturablePage(url)).toEqual({ ok: false, reason: "browser_page" });
    }
  });

  test("other protocols are refused", () => {
    for (const url of ["file:///C:/notes.txt", "data:text/html,hi", "javascript:alert(1)"]) {
      expect(capturablePage(url).ok).toBe(false);
    }
  });

  test("nothing at all is its own answer", () => {
    expect(capturablePage(undefined)).toEqual({ ok: false, reason: "no_url" });
    expect(capturablePage("not a url")).toEqual({ ok: false, reason: "no_url" });
  });
});

describe("safeAsset", () => {
  const base = "https://example.dev/posts/a";

  test("resolves a relative asset against the page", () => {
    expect(safeAsset("/og/x.png", base)).toBe("https://example.dev/og/x.png");
  });

  test("refuses anything that is not http", () => {
    // A page controls og:image, and this value becomes an <img src>.
    expect(safeAsset("javascript:alert(1)", base)).toBeUndefined();
    expect(safeAsset("data:image/png;base64,AAAA", base)).toBeUndefined();
    expect(safeAsset("https://user:pass@example.dev/x.png", base)).toBeUndefined();
    expect(safeAsset("", base)).toBeUndefined();
    expect(safeAsset(42, base)).toBeUndefined();
  });
});

describe("toWebCapture", () => {
  test("identity is the canonical URL, with tracking stripped", async () => {
    const capture = await captured();

    // utm_source gone, fragment gone, canonical link honoured.
    expect(capture.canonicalUrl).toBe("https://example.dev/posts/keyset-pagination");
    expect(capture.normalizedItem?.url).toBe(capture.canonicalUrl);
  });

  test("the same page from the toolbar and the menu is one item", async () => {
    const fromToolbar = await captured({}, "toolbar");
    const fromMenu = await captured(
      { url: "https://example.dev/posts/keyset-pagination?utm_campaign=x" },
      "context_menu",
    );

    expect(fromMenu.externalId).toBe(fromToolbar.externalId);
    expect(fromMenu.canonicalUrl).toBe(fromToolbar.canonicalUrl);
  });

  test("a canonical link pointing off-site is ignored", async () => {
    const capture = await captured({ canonical: "https://spam.example/steal" });

    expect(capture.canonicalUrl).toContain("example.dev");
  });

  test("a highlighted passage becomes the body, and the page text is kept", async () => {
    const capture = await captured({ selection: "  offset paging  drops rows  " }, "context_menu");

    expect(capture.normalizedItem?.body).toBe("offset paging drops rows");
    expect((capture.normalizedItem?.raw as { text?: string }).text).toContain(
      "Offset pagination",
    );
    expect(capture.captureMethod).toBe("context_menu");
  });

  test("without a selection the description carries the body", async () => {
    const capture = await captured();

    expect(capture.normalizedItem?.body).toBe(
      "Why offset paging drops rows when the set changes underneath.",
    );
  });

  test("a page with no metadata at all still produces a usable item", async () => {
    const capture = await captured({
      title: null,
      description: null,
      image: null,
      siteName: null,
      favicon: null,
      text: null,
      canonical: null,
    });

    expect(capture.normalizedItem?.body.length).toBeGreaterThan(0);
    expect(capture.normalizedItem?.authorHandle).toBe("example.dev");
    expect(capture.normalizedItem?.media).toEqual([]);
  });

  test("the saved-at is exact, because you pressed the button", async () => {
    const capture = await captured();

    expect(capture.normalizedItem?.savedAt).toBe(now);
    expect(capture.normalizedItem?.savedAtIsExact).toBe(true);
  });

  test("the event id is derived, so a double press is one event", async () => {
    const first = await captured();
    const second = await captured();

    expect(second.eventId).toBe(first.eventId);
  });

  test("long fields are bounded rather than shipped whole", async () => {
    const capture = await captured({
      title: "t".repeat(5_000),
      description: "d".repeat(9_000),
      text: "x".repeat(90_000),
    });

    expect((capture.normalizedItem?.title ?? "").length).toBeLessThanOrEqual(400);
    const raw = capture.normalizedItem?.raw as { description?: string; text?: string };
    expect((raw.description ?? "").length).toBeLessThanOrEqual(1_000);
    expect((raw.text ?? "").length).toBeLessThanOrEqual(20_000);
  });

  test("an unsavable page is refused rather than half-captured", async () => {
    const result = await toWebCapture(details({ url: "chrome://extensions" }), {
      method: "toolbar",
      observedAt: now,
    });

    expect(result).toEqual({ ok: false, reason: "browser_page" });
  });

  test("the capture names the web source and a web capture method", async () => {
    const capture = await captured();

    expect(capture.source).toBe("web");
    expect(capture.action).toBe("save");
    expect(["toolbar", "context_menu"]).toContain(capture.captureMethod);
  });
});
