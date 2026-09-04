/**
 * Saving the page you are looking at.
 *
 * The permission story is the design here. Every other source in this
 * extension has a fixed host permission because it always watches the same
 * site; a "save this page" button applies to any site, and asking for
 * `<all_urls>` to serve it would mean the extension could read every page you
 * ever open in exchange for a button you press occasionally.
 *
 * So it uses `activeTab` instead: pressing the toolbar button or a context
 * menu item grants access to that one tab, for that one moment, and it lapses.
 * The extension cannot read a page you did not ask it to save.
 *
 * Extraction and decisions are kept apart. The reader below runs inside the
 * page and only gathers strings; everything that decides anything lives in
 * pure functions here, so the parts that can be wrong can be tested without a
 * browser.
 */

import {
  canonicalizeWebUrl,
  webExternalId,
  type ItemEventCapture,
  type NormalizedItem,
} from "@anansi/sources";

/** Exactly what the injected reader hands back. Strings, and nothing decided. */
export interface PageDetails {
  url: string;
  title?: string | null;
  canonical?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
  favicon?: string | null;
  /** Whatever was highlighted when the menu item was used. */
  selection?: string | null;
  /** Rendered text, from innerText. See readPage for why that matters. */
  text?: string | null;
}

export type UnsupportedReason =
  | "unsupported_protocol"
  | "browser_page"
  | "no_url";

export type CapturableResult =
  | { ok: true; url: string }
  | { ok: false; reason: UnsupportedReason };

/**
 * Pages the browser will not let an extension read, and pages it should not.
 *
 * Naming them is better than letting the injection fail with a stack trace:
 * "this is a browser page" is a sentence, and "Cannot access contents of url"
 * is a bug report.
 */
const BROWSER_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "edge:",
  "about:",
  "view-source:",
  "devtools:",
]);

const CAPTURABLE_PROTOCOLS = new Set(["http:", "https:"]);

export function capturablePage(url: string | undefined | null): CapturableResult {
  if (!url) return { ok: false, reason: "no_url" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "no_url" };
  }
  if (BROWSER_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: "browser_page" };
  }
  if (!CAPTURABLE_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: "unsupported_protocol" };
  }
  return { ok: true, url: parsed.toString() };
}

export const UNSUPPORTED_MESSAGES: Record<UnsupportedReason, string> = {
  no_url: "there is no page here to save",
  browser_page: "this is a browser page, not a website",
  unsupported_protocol: "only http and https pages can be saved",
};

/* ------------------------------------------------------------ limits --- */

const LIMITS = {
  title: 400,
  description: 1_000,
  siteName: 200,
  /** Enough to be worth searching, far short of a copy of the page. */
  text: 20_000,
  selection: 10_000,
};

function trimTo(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Multi-line text keeps its lines; only runs of blank ones collapse. */
function trimBlock(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * An absolute http(s) URL, or nothing.
 *
 * A page can put anything in `og:image`, including a `javascript:` URL, and
 * this value ends up in an `<img src>` in the library.
 */
export function safeAsset(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value, base);
    if (!CAPTURABLE_PROTOCOLS.has(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------ the capture --- */

export interface CaptureOptions {
  /** How the user asked: the toolbar, or a right-click. */
  method: "toolbar" | "context_menu";
  /** Unix seconds. */
  observedAt: number;
}

export type WebCaptureResult =
  | { ok: true; capture: ItemEventCapture }
  | { ok: false; reason: UnsupportedReason };

/**
 * One page, as an item.
 *
 * The body prefers what you highlighted. Saving a paragraph out of a long
 * article and getting the whole article back is not what the selection was
 * for, and the full text is kept in `raw` either way.
 */
export async function toWebCapture(
  details: PageDetails,
  options: CaptureOptions,
): Promise<WebCaptureResult> {
  const supported = capturablePage(details.url);
  if (!supported.ok) return supported;

  const canonicalUrl = canonicalizeWebUrl(supported.url, details.canonical);
  if (!canonicalUrl) return { ok: false, reason: "unsupported_protocol" };

  const externalId = await webExternalId(canonicalUrl);
  const title = trimTo(details.title, LIMITS.title);
  const description = trimTo(details.description, LIMITS.description);
  const selection = trimBlock(details.selection, LIMITS.selection);
  const text = trimBlock(details.text, LIMITS.text);
  const image = safeAsset(details.image, supported.url);
  const favicon = safeAsset(details.favicon, supported.url);

  const item: NormalizedItem = {
    source: "web",
    externalId,
    url: canonicalUrl,
    kind: "article",
    title,
    body: selection ?? description ?? title ?? canonicalUrl,
    authorName: trimTo(details.siteName, LIMITS.siteName) ?? new URL(canonicalUrl).hostname,
    authorHandle: new URL(canonicalUrl).hostname,
    authorAvatar: favicon,
    savedAt: options.observedAt,
    // You pressed the button: this is the one source where the saved-at is
    // exactly right rather than an import stamp.
    savedAtIsExact: true,
    metrics: {},
    media: image ? [{ kind: "image", originUrl: image }] : [],
    links: [canonicalUrl],
    raw: {
      originalUrl: supported.url,
      siteName: trimTo(details.siteName, LIMITS.siteName),
      description,
      selection,
      text,
      capturedBy: options.method,
    },
  };

  return {
    ok: true,
    capture: {
      schemaVersion: 1,
      payloadType: "item_event",
      // Derived, so pressing the button twice on one page in the same second
      // is one event rather than two.
      eventId: `web:${externalId}:${options.observedAt}`,
      source: "web",
      action: "save",
      observedAt: options.observedAt,
      captureMethod: options.method,
      externalId,
      canonicalUrl,
      normalizedItem: item,
    },
  };
}

/* ------------------------------------------------------- the reader --- */

/**
 * Runs inside the page, and only reads.
 *
 * This is serialized and injected, so it must be self-contained: no imports,
 * no references to anything outside itself.
 *
 * `innerText` rather than a tree walk is deliberate and is the whole privacy
 * story of this function. It returns *rendered* text, which means script and
 * style contents, hidden elements, and the values of every form field — a
 * password box included — are excluded by construction rather than by a filter
 * that has to be right. Nothing here reads an input value, a cookie, or
 * storage.
 */
export function readPage(): PageDetails {
  const meta = (selector: string): string | null =>
    document.querySelector(selector)?.getAttribute("content") ?? null;

  const link = (selector: string): string | null =>
    document.querySelector(selector)?.getAttribute("href") ?? null;

  return {
    url: location.href,
    title:
      meta('meta[property="og:title"]') ??
      meta('meta[name="twitter:title"]') ??
      document.title ??
      null,
    canonical: link('link[rel="canonical"]'),
    description:
      meta('meta[property="og:description"]') ??
      meta('meta[name="description"]') ??
      meta('meta[name="twitter:description"]') ??
      null,
    image: meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]') ?? null,
    siteName: meta('meta[property="og:site_name"]') ?? null,
    favicon:
      link('link[rel="icon"]') ??
      link('link[rel="shortcut icon"]') ??
      link('link[rel="apple-touch-icon"]') ??
      "/favicon.ico",
    selection: window.getSelection()?.toString() ?? null,
    // Capped here as well as in the pure layer: a 40MB page should not be
    // serialized across the extension boundary just to be trimmed after.
    text: (document.body?.innerText ?? "").slice(0, 60_000),
  };
}
