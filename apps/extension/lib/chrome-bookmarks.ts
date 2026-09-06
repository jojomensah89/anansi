/**
 * Mirroring the browser's own bookmarks.
 *
 * Off by default, and the `bookmarks` permission is optional rather than
 * declared: your entire browsing history is legible from your bookmark tree,
 * and an extension that reads it because it might one day be asked to is
 * asking for far more than it needs. The grant happens at the moment you turn
 * this on, and goes away when you turn it off.
 *
 * The distinction that shapes everything here is that a Chrome bookmark is a
 * *node*, not a page. The same URL saved into two folders is two nodes, and
 * deleting one of them is not the same as no longer having the page
 * bookmarked. So each node becomes a source link against one item, and the
 * item stops being present only when the last of its nodes goes — which the
 * server already knows how to work out.
 */

import {
  canonicalizeWebUrl,
  webExternalId,
  type ItemEventCapture,
  type NormalizedItem,
} from "@anansi/sources";

/** The parts of a Chrome bookmark node this needs. */
export interface BookmarkNode {
  id: string;
  title?: string;
  url?: string;
  /** Milliseconds, as Chrome reports it. */
  dateAdded?: number;
  children?: BookmarkNode[];
}

/**
 * A node worth mirroring.
 *
 * Folders have no url and are structure rather than content. Everything else
 * without an http(s) url — a javascript: bookmarklet, a file:// path, a
 * chrome:// shortcut — is either not a page or not one this can fetch or
 * render, and would arrive in the library as a row that does nothing.
 */
export function isMirrorable(node: BookmarkNode): boolean {
  if (!node.url) return false;
  try {
    const url = new URL(node.url);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Every bookmark under these nodes, folders flattened away. */
export function mirrorableNodes(nodes: BookmarkNode[]): BookmarkNode[] {
  const found: BookmarkNode[] = [];
  const walk = (list: BookmarkNode[]) => {
    for (const node of list) {
      if (isMirrorable(node)) found.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/** Seconds, from Chrome's milliseconds, and never in the future. */
function addedAt(node: BookmarkNode, now: number): number {
  if (typeof node.dateAdded !== "number" || !Number.isFinite(node.dateAdded)) return now;
  const seconds = Math.floor(node.dateAdded / 1000);
  return seconds > 0 && seconds <= now ? seconds : now;
}

function trim(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export type BookmarkAction = "save" | "unsave";
export interface BookmarkCaptureOptions {
  installationId?: string;
  /** Set once at the gesture; the persisted capture retains this ID for retries. */
  mutationId?: string;
}

/**
 * One node, as a capture.
 *
 * The item identity is the canonical URL, the same one the toolbar's page
 * capture produces — bookmarking a page you had already clipped should not
 * make a second copy of it. The node id is carried separately as the source
 * link, which is what lets two folders hold the same page without either
 * one's removal claiming the page is gone.
 *
 * Chrome gives a title and a URL and nothing else: no description, no image,
 * no text. That is honest and it is why mirroring is not a substitute for
 * saving a page from the toolbar, which reads the page itself.
 */
export async function toBookmarkCapture(
  node: BookmarkNode,
  action: BookmarkAction,
  now: number,
  options: BookmarkCaptureOptions = {},
): Promise<ItemEventCapture | null> {
  if (!isMirrorable(node)) return null;

  const canonicalUrl = canonicalizeWebUrl(node.url as string);
  if (!canonicalUrl) return null;

  const externalId = await webExternalId(canonicalUrl);
  const observedAt = now;
  const nodeIdentity = options.installationId ? `${options.installationId}:${node.id}` : node.id;
  const title = trim(node.title, 400);
  const host = new URL(canonicalUrl).hostname;

  const item: NormalizedItem = {
    source: "web",
    externalId,
    url: canonicalUrl,
    kind: "article",
    title,
    body: title ?? canonicalUrl,
    authorName: host,
    authorHandle: host,
    savedAt: addedAt(node, now),
    // Chrome records when you bookmarked it, so this is a real date rather
    // than the time an import happened to run.
    savedAtIsExact: true,
    metrics: {},
    media: [],
    links: [canonicalUrl],
    raw: { chromeNodeId: node.id, chromeTitle: node.title ?? null },
  };

  return {
    schemaVersion: 1,
    payloadType: "item_event",
    // A fresh immutable mutation identity, persisted by the capture queue.
    eventId: `chrome:${action}:${nodeIdentity}:${options.mutationId ?? crypto.randomUUID()}`,
    source: "web",
    action,
    observedAt,
    captureMethod: "chrome_bookmark",
    externalId,
    canonicalUrl,
    sourceLink: { kind: "chrome_bookmark", externalId: nodeIdentity },
    ...(action === "save" ? { normalizedItem: item } : {}),
  };
}

/**
 * Removing a folder removes everything in it.
 *
 * Chrome reports one event for the folder and none for its contents, so
 * without walking the removed subtree every bookmark inside it would stay
 * marked present forever — the library would quietly disagree with the
 * browser and never say so.
 */
export async function removalCaptures(
  node: BookmarkNode,
  now: number,
  options: BookmarkCaptureOptions = {},
): Promise<ItemEventCapture[]> {
  const captures = await Promise.all(
    mirrorableNodes([node]).map((n) => toBookmarkCapture(n, "unsave", now, options)),
  );
  return captures.filter((c): c is ItemEventCapture => c !== null);
}

/** Every bookmark in the tree, as saves, for the one-time import. */
export async function importCaptures(
  tree: BookmarkNode[],
  now: number,
  options: BookmarkCaptureOptions = {},
): Promise<ItemEventCapture[]> {
  const captures = await Promise.all(
    mirrorableNodes(tree).map((n) => toBookmarkCapture(n, "save", now, options)),
  );
  return captures.filter((c): c is ItemEventCapture => c !== null);
}
