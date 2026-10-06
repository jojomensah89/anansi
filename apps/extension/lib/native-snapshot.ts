import { parseBookmarkCapture, parseBookmarksPage, parseItemList, parseSavedListing, parseStarredPage, type NormalizedItem } from "@anansi/sources";
import type { PlatformSource } from "./messages.ts";

type PlainRecord = Record<string, unknown>;

const MAX_NATIVE_OBJECTS = 10_000;
const MAX_NATIVE_CHILDREN = 2_000;
const MAX_NATIVE_PAYLOAD_CHARS = 2_000_000;
const MAX_SNAPSHOT_TEXT_CHARS = 100_000;

function asRecord(value: unknown): PlainRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as PlainRecord : undefined;
}

function sourcePathId(item: NormalizedItem): string | undefined {
	try {
		const url = new URL(item.url);
		if (url.protocol !== "https:" || url.username || url.password) return;
		const path = url.pathname.replace(/\/$/, "");
		if (item.source === "x") {
			if (url.hostname !== "x.com" && url.hostname !== "www.x.com") return;
			return path.match(/^\/[^/]+\/status\/(\d+)$/)?.[1];
		}
		if (item.source === "tiktok") {
			if (url.hostname !== "tiktok.com" && url.hostname !== "www.tiktok.com") return;
			const id = path.match(/^\/(?:@[^/]+\/)?video\/(\d+)$/)?.[1];
			return id;
		}
		if (item.source === "github") {
			if (url.hostname !== "github.com") return;
			const parts = path.split("/").filter(Boolean);
			return parts.length === 2 ? parts.join("/").toLowerCase() : undefined;
		}
		if (item.source === "reddit") {
			if (!["reddit.com", "www.reddit.com", "old.reddit.com"].includes(url.hostname)) return;
			const parts = path.split("/").filter(Boolean);
			const comments = parts.indexOf("comments");
			if (comments < 0) return;
			if (item.externalId.startsWith("t3_")) {
				const postId = parts[comments + 1];
				return postId && /^[a-z0-9]{1,20}$/i.test(postId) ? `t3_${postId.toLowerCase()}` : undefined;
			}
			if (item.externalId.startsWith("t1_")) {
				const commentId = parts.length > comments + 3 ? parts.at(-1) : undefined;
				return commentId && /^[a-z0-9]{1,20}$/i.test(commentId) ? `t1_${commentId.toLowerCase()}` : undefined;
			}
		}
	} catch { /* Invalid or non-canonical source URLs are not snapshots. */ }
	return;
}

function xTweetIdentity(tweet: PlainRecord | undefined): string | undefined {
	const legacy = asRecord(tweet?.legacy);
	const id = tweet?.rest_id ?? legacy?.id_str;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function unwrapXTweet(value: unknown): PlainRecord | undefined {
	let tweet = asRecord(value);
	for (let depth = 0; tweet && depth < 3; depth++) {
		const nested = asRecord(tweet.tweet);
		if (nested && (tweet.__typename === "TweetWithVisibilityResults" || !asRecord(tweet.legacy))) tweet = nested;
		else break;
	}
	return tweet;
}

function xRetweetIdentityProof(item: NormalizedItem): { outerId: string; subjectId: string } | undefined {
	const expectedSubjectId = sourcePathId(item);
	const tweet = unwrapXTweet(asRecord(item.raw)?.tweet);
	const outerId = xTweetIdentity(tweet);
	const legacy = asRecord(tweet?.legacy);
	const retweeted = unwrapXTweet(asRecord(legacy?.retweeted_status_result)?.result);
	const subjectId = xTweetIdentity(retweeted);
	if (typeof outerId === "string" && typeof subjectId === "string" && typeof expectedSubjectId === "string" &&
		outerId === item.externalId && subjectId === expectedSubjectId && subjectId !== outerId) {
		return { outerId, subjectId };
	}
	return;
}

function matchesNativeIdentity(item: NormalizedItem): boolean {
	const pathId = sourcePathId(item);
	if (!pathId) return false;
	if (pathId === item.externalId) return true;
	if (item.source !== "x") return false;
	const raw = asRecord(item.raw);
	const proof = asRecord(raw?.nativeIdentity);
	const providerProof = xRetweetIdentityProof(item);
	if (raw && "tweet" in raw && !providerProof) return false;
	if (providerProof && proof &&
		(providerProof.outerId !== proof.outerId || providerProof.subjectId !== proof.subjectId)) return false;
	const observed = providerProof ?? proof;
	return observed?.outerId === item.externalId && observed.subjectId === pathId;
}

function hasCompleteXText(tweet: PlainRecord): boolean {
	const legacy = asRecord(tweet.legacy);
	const noteTweetValue = tweet.note_tweet;
	const noteTweet = asRecord(noteTweetValue);
	const noteResult = asRecord(asRecord(noteTweet?.note_tweet_results)?.result);
	const noteText = noteResult?.text;
	const hasCompleteNoteText = typeof noteText === "string" && noteText.trim().length > 0;
	if (noteTweetValue != null && !hasCompleteNoteText) return false;
	return !legacy?.truncated || hasCompleteNoteText;
}

function hasCompleteXProviderData(rawValue: unknown): boolean {
	const raw = asRecord(rawValue);
	if (!raw || !("tweet" in raw)) return true;
	if (!asRecord(raw.tweet)) return false;
	const pending: unknown[] = [raw.tweet];
	const visited = new Set<object>();
	let count = 0;
	while (pending.length && count++ < MAX_NATIVE_OBJECTS) {
		const value = pending.pop();
		const tweet = asRecord(value);
		if (!tweet || visited.has(tweet)) continue;
		visited.add(tweet);
		const legacy = asRecord(tweet.legacy);
		if (legacy && xTweetIdentity(tweet) && !hasCompleteXText(tweet)) return false;
		for (const child of Object.values(tweet)) if (child && typeof child === "object") pending.push(child);
	}
	return pending.length === 0;
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= MAX_SNAPSHOT_TEXT_CHARS ? value : undefined;
}

function sanitizedXRaw(item: NormalizedItem): PlainRecord {
	const raw = asRecord(item.raw);
	if (!raw) return {};
	const safe: PlainRecord = {};
	if (typeof raw.isRetweet === "boolean") safe.isRetweet = raw.isRetweet;
	for (const key of ["retweetedBy", "ownText", "quotedId", "inReplyToStatusId", "conversationId"] as const) {
		const value = safeString(raw[key]);
		if (value !== undefined) safe[key] = value;
	}
	const quoted = asRecord(raw.quoted);
	if (quoted) {
		const safeQuoted: PlainRecord = {};
		for (const key of ["handle", "name", "avatar", "text", "url"] as const) {
			const value = safeString(quoted[key]);
			if (value !== undefined || quoted[key] === null) safeQuoted[key] = value ?? null;
		}
		if (Array.isArray(quoted.mediaUrls)) {
			safeQuoted.mediaUrls = quoted.mediaUrls
				.filter((value): value is string => typeof value === "string" && value.length <= 2_000 && value.startsWith("https://"))
				.slice(0, 20);
		}
		safe.quoted = safeQuoted;
	}
	const proof = xRetweetIdentityProof(item);
	if (proof) safe.nativeIdentity = proof;
	return safe;
}

function sanitizedSnapshotItem(item: NormalizedItem): NormalizedItem {
	return { ...item, raw: item.source === "x" ? sanitizedXRaw(item) : {} };
}

export function completeNativeItem(item: NormalizedItem): boolean {
	if (typeof item.body !== "string" || item.body.length > MAX_SNAPSHOT_TEXT_CHARS) return false;
	if (item.title !== undefined && (typeof item.title !== "string" || item.title.length > MAX_SNAPSHOT_TEXT_CHARS)) return false;
	if (item.body.trim().length === 0 && !item.title?.trim() && item.media.length === 0) return false;
	if (!matchesNativeIdentity(item)) return false;
	if (item.source === "x" && !hasCompleteXProviderData(item.raw)) return false;
	try {
		return parseBookmarkCapture({ schemaVersion: 1, payloadType: "item_event", eventId: "snapshot-validation",
			source: item.source, action: "save", externalId: item.externalId, canonicalUrl: item.url,
			observedAt: Math.max(1, item.savedAt), captureMethod: "platform_event", normalizedItem: item }).ok;
	} catch { return false; }
}

/** Reuse the server's normalizers for bounded objects already seen by the page. */
export function nativeItemsFromPayload(source: PlatformSource, raw: unknown, now: number): NormalizedItem[] {
	const result = new Map<string, NormalizedItem>();
	const pending: unknown[] = [raw];
	const visitedObjects = new Set<object>();
	let visited = 0;
	while (pending.length && visited++ < MAX_NATIVE_OBJECTS) {
		const value = pending.pop();
		if (!value || typeof value !== "object") continue;
		if (visitedObjects.has(value)) continue;
		visitedObjects.add(value);
		const obj = value as Record<string, any>;
		let items: NormalizedItem[] = [];
		try {
			if (source === "x" && obj.legacy && (obj.rest_id || obj.legacy.id_str) && hasCompleteXText(obj)) {
				items = parseBookmarksPage({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ entries: [{
					entryId: `tweet-${obj.rest_id ?? obj.legacy.id_str}`,
					content: { itemContent: { tweet_results: { result: obj } } },
				}] }] } } } }, { importedAt: now }).items;
			} else if (source === "tiktok" && typeof obj.id === "string" && typeof obj.desc === "string" && obj.author?.uniqueId && obj.video) {
				items = parseItemList({ itemList: [obj] }, { importedAt: now });
			} else if (source === "reddit" && (obj.kind === "t1" || obj.kind === "t3") && obj.data?.name) {
				items = parseSavedListing({ data: { children: [obj] } }, { importedAt: now });
			} else if (source === "github" && obj.full_name && obj.html_url && obj.owner) {
				items = parseStarredPage({ starred: [obj] }, { importedAt: now });
			}
		} catch { /* Ignore unrelated response objects. */ }
		for (const item of items) {
			if (item.source === "x" && !hasCompleteXProviderData(item.raw)) continue;
			const snapshot = sanitizedSnapshotItem(item);
			if (completeNativeItem(snapshot)) result.set(snapshot.externalId, snapshot);
		}
		try {
			let children = 0;
			for (const child of Object.values(obj)) {
				if (!child || typeof child !== "object") continue;
				if (++children > MAX_NATIVE_CHILDREN) break;
				pending.push(child);
			}
		} catch { /* Ignore provider objects with unexpected accessors. */ }
	}
	return [...result.values()];
}

function href(element: Element | null, baseUrl?: string): string | undefined {
	const value = element?.getAttribute("href");
	if (!value) return;
	try { return new URL(value, baseUrl || element!.ownerDocument.location?.href || "https://x.com").href; } catch { return; }
}

function postText(element: Element | null): string | undefined {
	if (!element) return;
	const copy = element.cloneNode(true) as Element;
	for (const image of copy.querySelectorAll("img[alt]")) image.replaceWith(image.getAttribute("alt") ?? "");
	for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
	return copy.textContent?.trim();
}

function redditFullname(value: string | null): string | undefined {
	const normalized = value?.trim().toLowerCase().replace(/^thing_/, "");
	return normalized && /^t[13]_[a-z0-9]{1,20}$/.test(normalized) ? normalized : undefined;
}

function redditDomFullname(element: Element): string | undefined {
	for (const attribute of ["post-id", "data-fullname", "data-post-id", "id"] as const) {
		const fullname = redditFullname(element.getAttribute(attribute));
		if (fullname) return fullname;
	}
	return;
}

function matchesRedditDomFullname(element: Element, expectedFullname: string): boolean {
	if (redditDomFullname(element) === expectedFullname) return true;
	const expectedBareId = expectedFullname.slice(3);
	return ["post-id", "data-fullname", "data-post-id", "id"].some((attribute) => {
		const value = element.getAttribute(attribute)?.toLowerCase();
		return value === expectedBareId || value === `thing_${expectedFullname}`;
	});
}

function redditPostText(element: Element | null): string | undefined {
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
	return [...element.childNodes].map(visit).join("")
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function tiktokHydrationItem(id: string, doc: Document, now: number): NormalizedItem | undefined {
	let scannedChars = 0;
	for (const scriptId of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]) {
		const script = doc.getElementById(scriptId);
		const text = script?.textContent;
		if (!text?.trim()) continue;
		if (text.length > MAX_NATIVE_PAYLOAD_CHARS - scannedChars) return;
		scannedChars += text.length;
		try {
			const payload: unknown = JSON.parse(text);
			const item = nativeItemsFromPayload("tiktok", payload, now).find((candidate) => candidate.externalId === id);
			if (item) return item;
		} catch { /* Ignore absent, malformed, or unrelated hydration state. */ }
	}
	return;
}

/** Only recognized, complete visible item containers qualify as a snapshot. */
export function nativeItemFromDocument(source: PlatformSource, id: string, doc: Document, now: number): NormalizedItem | undefined {
	const links = [...doc.querySelectorAll("a[href]")];
	const base = { source, externalId: id, savedAt: now, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {} };
	let item: NormalizedItem | undefined;
	if (source === "x") {
		const link = links.find((a) => href(a, "https://x.com")?.match(/\/status\/(\d+)/)?.[1] === id && a.querySelector("time"));
		const root = link?.closest("article");
		if (!root || root.querySelector('[data-testid="tweet-text-show-more-link"]')) return;
		const primary = root.querySelector('a[href*="/status/"]:has(time)');
		if (href(primary, "https://x.com")?.match(/\/status\/(\d+)/)?.[1] !== id) return;
		const text = postText(root.querySelector('[data-testid="tweetText"]'));
		if (!text) return;
		// Quoted posts need their provider object so author/context is not lost.
		if (root.querySelectorAll('[data-testid="tweetText"]').length > 1) return;
		const url = href(link ?? null, "https://x.com")!;
		item = { ...base, kind: "post", url, body: text, authorHandle: new URL(url).pathname.split("/")[1],
			media: [...root.querySelectorAll('[data-testid="tweetPhoto"] img')].map((image) => ({ kind: "image" as const, originUrl: image.getAttribute("src") ?? "" })).filter((m) => m.originUrl.startsWith("https://")) };
	} else if (source === "github") {
		const match = links.find((a) => {
			try {
				const url = new URL(href(a, "https://github.com")!);
				return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.toLowerCase().replace(/\/$/, "") === `/${id.toLowerCase()}`;
			} catch { return false; }
		});
		let current = false;
		try {
			const location = new URL(doc.location?.href ?? "");
			current = location.protocol === "https:" && location.hostname === "github.com" &&
				location.pathname.toLowerCase().replace(/\/$/, "") === `/${id.toLowerCase()}`;
		} catch { /* The document may have no location in a detached DOM. */ }
		if (!current && !match) return;
		const root = current ? doc.querySelector("main") : match?.closest("article, li, .col-12, .Box-row");
		if (!root) return;
		const descriptionElement = root.querySelector('[itemprop="about"], [data-testid="repository-description"], p.f4, p[itemprop="description"], .color-fg-muted.mb-3');
		if (!descriptionElement) return;
		const description = descriptionElement.textContent?.trim() ?? "";
		item = { ...base, kind: "repo", url: `https://github.com/${id}`, title: id, body: description, authorHandle: id.split("/")[0] };
	} else if (source === "reddit") {
		const expectedFullname = /^t[13]_[a-z0-9]{1,20}$/i.test(id) ? id.toLowerCase() : undefined;
		if (!expectedFullname) return;
		const root = [...doc.querySelectorAll("shreddit-post, .thing")].find((element) => matchesRedditDomFullname(element, expectedFullname));
		if (!root || root.querySelector('[slot="text-body"] [aria-expanded="false"], .expando-button.collapsed')) return;
		const title = root.getAttribute("post-title") ?? root.querySelector("a.title")?.textContent?.trim();
		const body = redditPostText(root.querySelector('[slot="text-body"], .usertext-body'));
		const linkOnly = root.getAttribute("post-type") === "link" || root.classList.contains("link") && !root.classList.contains("self");
		if (!title || (!body && !linkOnly)) return;
		const permalink = root.getAttribute("permalink") ?? root.querySelector('a.comments, a[slot="full-post-link"]')?.getAttribute("href");
		if (!permalink) return;
		let redditUrl: string;
		try {
			const parsed = new URL(permalink, "https://www.reddit.com");
			if (!["www.reddit.com", "reddit.com", "old.reddit.com"].includes(parsed.hostname) || parsed.protocol !== "https:") return;
			redditUrl = parsed.href;
		} catch { return; }
		item = { ...base, kind: "post", url: redditUrl, title, body: body ?? title, authorHandle: root.getAttribute("author") ?? undefined };
	} else {
		const hydrated = tiktokHydrationItem(id, doc, now);
		if (hydrated) return hydrated;
		const link = links.find((a) => href(a, "https://www.tiktok.com")?.match(/\/video\/(\d+)/)?.[1] === id);
		const root = link?.closest('article, [data-e2e="recommend-list-item-container"], [data-e2e="browse-video"]');
		if (!root || root.querySelector('[data-e2e="more-button"]')) return;
		const text = root.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]')?.textContent?.trim();
		if (!text) return;
		item = { ...base, kind: "post", url: href(link ?? null, "https://www.tiktok.com")!, body: text };
	}
	return item && completeNativeItem(item) ? item : undefined;
}

export function createNativeSnapshotCache(source: PlatformSource) {
	const items = new Map<string, { item: NormalizedItem; at: number }>();
	const remember = (item: NormalizedItem) => {
		items.delete(item.externalId);
		items.set(item.externalId, { item, at: Date.now() });
		while (items.size > 100) items.delete(items.keys().next().value!);
	};
	const collect = (raw: unknown) => {
		for (const item of nativeItemsFromPayload(source, raw, Math.floor(Date.now() / 1000))) remember(item);
	};
	const get = (id: string) => {
		const cached = items.get(id);
		if (cached && Date.now() - cached.at < 300_000) return cached.item;
		const item = nativeItemFromDocument(source, id, document, Math.floor(Date.now() / 1000));
		if (item) remember(item);
		return item;
	};
	// Snapshot the visible target before a native handler can remove/recycle it.
	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const root = target?.closest('article, shreddit-post, .thing, .Box-row, [data-e2e="recommend-list-item-container"], main');
		if (!root) return;
		if (source === "reddit") {
			const fullname = redditDomFullname(root);
			if (fullname) get(fullname);
			return;
		}
		for (const link of [...root.querySelectorAll("a[href]")].slice(0, 100)) {
			const url = href(link);
			if (!url) continue;
			const id = source === "x" ? url.match(/\/status\/(\d+)/)?.[1]
				: source === "tiktok" ? url.match(/\/video\/(\d+)/)?.[1]
				: new URL(url).hostname === "github.com" && /^\/[^/]+\/[^/]+\/?$/.test(new URL(url).pathname) ? new URL(url).pathname.slice(1).replace(/\/$/, "").toLowerCase() : undefined;
			if (id) get(id);
		}
	}, true);
	const originalFetch = window.fetch;
	window.fetch = Object.assign(function(this: unknown, ...args: Parameters<typeof fetch>) {
		const response = originalFetch.apply(this, args);
		void response.then((res) => {
			if (!res.ok || !res.headers.get("content-type")?.includes("json") || Number(res.headers.get("content-length")) > 2_000_000) return;
			void res.clone().text().then((text) => { if (text.length <= 2_000_000) collect(JSON.parse(text)); }).catch(() => {});
		}).catch(() => {});
		return response;
	}, originalFetch);
	return { get, collect };
}
