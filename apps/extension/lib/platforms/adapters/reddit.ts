import { parseSavedListing, type NormalizedItem } from "@anansi/sources";
import { type NativeSnapshotAdapter, type PlatformCaptureAdapter } from "../capture-adapter.ts";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function sourcePathId(item: NormalizedItem): string | undefined {
	try {
		const url = new URL(item.url);
		if (url.protocol !== "https:" || url.username || url.password || !["reddit.com", "www.reddit.com", "old.reddit.com"].includes(url.hostname)) return;
		const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
		const comments = parts.indexOf("comments");
		if (comments < 0) return;
		if (item.externalId.startsWith("t3_")) {
			const id = parts[comments + 1];
			return id && /^[a-z0-9]{1,20}$/i.test(id) ? `t3_${id.toLowerCase()}` : undefined;
		}
		if (item.externalId.startsWith("t1_")) {
			const id = parts.length > comments + 3 ? parts.at(-1) : undefined;
			return id && /^[a-z0-9]{1,20}$/i.test(id) ? `t1_${id.toLowerCase()}` : undefined;
		}
	} catch { /* Non-canonical URLs are not snapshots. */ }
	return;
}

function fullname(value: string | null): string | undefined {
	const normalized = value?.trim().toLowerCase().replace(/^thing_/, "");
	return normalized && /^t[13]_[a-z0-9]{1,20}$/.test(normalized) ? normalized : undefined;
}

function domFullname(element: Element): string | undefined {
	for (const attribute of ["post-id", "data-fullname", "data-post-id", "id"] as const) {
		const id = fullname(element.getAttribute(attribute));
		if (id) return id;
	}
	return;
}

function matchesDomFullname(element: Element, expected: string): boolean {
	if (domFullname(element) === expected) return true;
	const bare = expected.slice(3);
	return ["post-id", "data-fullname", "data-post-id", "id"].some((attribute) => {
		const value = element.getAttribute(attribute)?.toLowerCase();
		return value === bare || value === `thing_${expected}`;
	});
}

function postText(element: Element | null): string | undefined {
	if (!element) return;
	const blockTags = new Set(["blockquote", "div", "p", "pre"]);
	const visit = (node: Node): string => {
		if (node.nodeType === 3) return node.textContent ?? "";
		if (node.nodeType !== 1) return "";
		const current = node as Element;
		const tag = current.tagName.toLowerCase();
		if (tag === "br") return "\n";
		if (tag === "img") return current.getAttribute("alt") ?? "";
		const content = [...current.childNodes].map(visit).join("");
		if (tag === "li") return content.trim();
		if (tag === "ul" || tag === "ol") {
			const items = [...current.childNodes]
				.filter((child): child is Element => child.nodeType === 1 && (child as Element).tagName.toLowerCase() === "li")
				.map((item, index) => `${tag === "ol" ? `${index + 1}.` : "•"} ${[...item.childNodes].map(visit).join("").trim()}`);
			return `\n${items.join("\n")}\n`;
		}
		return blockTags.has(tag) ? `\n${content.trim()}\n` : content;
	};
	return [...element.childNodes].map(visit).join("").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseObject(value: RecordValue, now: number): NormalizedItem[] {
	if ((value.kind !== "t1" && value.kind !== "t3") || !asRecord(value.data)?.name) return [];
	return parseSavedListing({ data: { children: [value] } }, { importedAt: now });
}

function href(element: Element | null, baseUrl?: string): string | undefined {
	const value = element?.getAttribute("href");
	if (!value) return;
	try { return new URL(value, baseUrl || element!.ownerDocument.location?.href || "https://www.reddit.com").href; } catch { return; }
}

function fromDocument(id: string, doc: Document, now: number): NormalizedItem | undefined {
	const expected = /^t[13]_[a-z0-9]{1,20}$/i.test(id) ? id.toLowerCase() : undefined;
	if (!expected) return;
	const root = [...doc.querySelectorAll("shreddit-post, .thing")].find((element) => matchesDomFullname(element, expected));
	if (!root || root.querySelector('[slot="text-body"] [aria-expanded="false"], .expando-button.collapsed')) return;
	const title = root.getAttribute("post-title") ?? root.querySelector("a.title")?.textContent?.trim();
	const body = postText(root.querySelector('[slot="text-body"], .usertext-body'));
	const linkOnly = root.getAttribute("post-type") === "link" || root.classList.contains("link") && !root.classList.contains("self");
	if (!title || (!body && !linkOnly)) return;
	const permalink = root.getAttribute("permalink") ?? root.querySelector('a.comments, a[slot="full-post-link"]')?.getAttribute("href");
	if (!permalink) return;
	let url: string;
	try { const parsed = new URL(permalink, "https://www.reddit.com"); if (!["www.reddit.com", "reddit.com", "old.reddit.com"].includes(parsed.hostname) || parsed.protocol !== "https:") return; url = parsed.href; }
	catch { return; }
	return { source: "reddit", externalId: id, savedAt: now, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {}, kind: "post", url, title, body: body ?? title, authorHandle: root.getAttribute("author") ?? undefined };
}

const nativeSnapshot: NativeSnapshotAdapter = {
	parseObject,
	matchesIdentity: (item) => sourcePathId(item) === item.externalId.toLowerCase(),
	hasCompleteProviderData: () => true,
	sanitize: (item) => ({ ...item, raw: {} }),
	fromDocument,
	idsFromClickTarget(root) { const id = domFullname(root); return id ? [id] : []; },
};

export const redditCaptureAdapter = {
	source: "reddit",
	hosts: ["www.reddit.com", "old.reddit.com", "reddit.com"],
	tabPatterns: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
	entryUrl: "https://www.reddit.com/user/me/saved/",
	importMode: "session",
	isExternalId: (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value),
	canonicalUrl: (id: string) => `https://www.reddit.com/comments/${id.replace(/^t[13]_/, "")}`,
	parsePage: (raw: unknown, importedAt: number) => parseSavedListing(raw, { importedAt }),
	isExpectedImportTab(value: string) {
		try { const url = new URL(value); return (url.hostname === "reddit.com" || url.hostname.endsWith(".reddit.com")) && /^\/user\/[^/]+\/saved\/?$/.test(url.pathname); }
		catch { return false; }
	},
	protocol: {
		events: { actions: ["ready", "saved", "bookmark", "page", "done", "error"], ready: "relay-only", pageRequiresRunId: false, doneRequiresRunId: false, errorRequiresRunId: false },
		commands: { actions: ["ready", "configure", "backfill"], requiredRunIdActions: [] },
	},
	nativeSnapshot,
} satisfies PlatformCaptureAdapter<"reddit">;

