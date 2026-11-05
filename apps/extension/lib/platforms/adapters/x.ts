import { parseBookmarksPage, type NormalizedItem } from "@anansi/sources";
import { tweetUrl } from "../x.ts";
import { NATIVE_SNAPSHOT_LIMITS, type NativeSnapshotAdapter, type PlatformCaptureAdapter } from "../capture-adapter.ts";
import { nativeItemsFromPayloadWithAdapter } from "../native-snapshot-core.ts";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function sourcePathId(item: NormalizedItem): string | undefined {
	try {
		const url = new URL(item.url);
		if (url.protocol !== "https:" || url.username || url.password || (url.hostname !== "x.com" && url.hostname !== "www.x.com")) return;
		return url.pathname.replace(/\/$/, "").match(/^\/[^/]+\/status\/(\d+)$/)?.[1];
	} catch { return; }
}

function tweetIdentity(tweet: RecordValue | undefined): string | undefined {
	const legacy = asRecord(tweet?.legacy);
	const id = tweet?.rest_id ?? legacy?.id_str;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function unwrapTweet(value: unknown): RecordValue | undefined {
	let tweet = asRecord(value);
	for (let depth = 0; tweet && depth < 3; depth++) {
		const nested = asRecord(tweet.tweet);
		if (nested && (tweet.__typename === "TweetWithVisibilityResults" || !asRecord(tweet.legacy))) tweet = nested;
		else break;
	}
	return tweet;
}

function retweetIdentityProof(item: NormalizedItem): { outerId: string; subjectId: string } | undefined {
	const expectedSubjectId = sourcePathId(item);
	const tweet = unwrapTweet(asRecord(item.raw)?.tweet);
	const outerId = tweetIdentity(tweet);
	const legacy = asRecord(tweet?.legacy);
	const retweeted = unwrapTweet(asRecord(legacy?.retweeted_status_result)?.result);
	const subjectId = tweetIdentity(retweeted);
	if (typeof outerId === "string" && typeof subjectId === "string" && typeof expectedSubjectId === "string" &&
		outerId === item.externalId && subjectId === expectedSubjectId && subjectId !== outerId) return { outerId, subjectId };
	return;
}

function matchesIdentity(item: NormalizedItem): boolean {
	const pathId = sourcePathId(item);
	if (!pathId) return false;
	if (pathId === item.externalId) return true;
	const raw = asRecord(item.raw);
	const proof = asRecord(raw?.nativeIdentity);
	const providerProof = retweetIdentityProof(item);
	if (raw && "tweet" in raw && !providerProof) return false;
	if (providerProof && proof && (providerProof.outerId !== proof.outerId || providerProof.subjectId !== proof.subjectId)) return false;
	const observed = providerProof ?? proof;
	return observed?.outerId === item.externalId && observed.subjectId === pathId;
}

function hasCompleteText(tweet: RecordValue): boolean {
	const legacy = asRecord(tweet.legacy);
	const noteTweetValue = tweet.note_tweet;
	const noteTweet = asRecord(noteTweetValue);
	const noteResult = asRecord(asRecord(noteTweet?.note_tweet_results)?.result);
	const noteText = noteResult?.text;
	const hasCompleteNoteText = typeof noteText === "string" && noteText.trim().length > 0;
	if (noteTweetValue != null && !hasCompleteNoteText) return false;
	return !legacy?.truncated || hasCompleteNoteText;
}

function hasCompleteProviderData(rawValue: unknown, maxObjects: number): boolean {
	const raw = asRecord(rawValue);
	if (!raw || !("tweet" in raw)) return true;
	if (!asRecord(raw.tweet)) return false;
	const pending: unknown[] = [raw.tweet];
	const visited = new Set<object>();
	let count = 0;
	while (pending.length && count++ < maxObjects) {
		const value = pending.pop();
		const tweet = asRecord(value);
		if (!tweet || visited.has(tweet)) continue;
		visited.add(tweet);
		const legacy = asRecord(tweet.legacy);
		if (legacy && tweetIdentity(tweet) && !hasCompleteText(tweet)) return false;
		for (const child of Object.values(tweet)) if (child && typeof child === "object") pending.push(child);
	}
	return pending.length === 0;
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= NATIVE_SNAPSHOT_LIMITS.maxTextChars ? value : undefined;
}

function sanitize(item: NormalizedItem): NormalizedItem {
	const raw = asRecord(item.raw);
	if (!raw) return { ...item, raw: {} };
	const safe: RecordValue = {};
	if (typeof raw.isRetweet === "boolean") safe.isRetweet = raw.isRetweet;
	for (const key of ["retweetedBy", "ownText", "quotedId", "inReplyToStatusId", "conversationId"] as const) {
		const value = safeString(raw[key]);
		if (value !== undefined) safe[key] = value;
	}
	const quoted = asRecord(raw.quoted);
	if (quoted) {
		const safeQuoted: RecordValue = {};
		for (const key of ["handle", "name", "avatar", "text", "url"] as const) {
			const value = safeString(quoted[key]);
			if (value !== undefined || quoted[key] === null) safeQuoted[key] = value ?? null;
		}
		if (Array.isArray(quoted.mediaUrls)) safeQuoted.mediaUrls = quoted.mediaUrls
			.filter((value): value is string => typeof value === "string" && value.length <= 2_000 && value.startsWith("https://"))
			.slice(0, 20);
		safe.quoted = safeQuoted;
	}
	const proof = retweetIdentityProof(item);
	if (proof) safe.nativeIdentity = proof;
	return { ...item, raw: safe };
}

function parseObject(value: RecordValue, now: number): NormalizedItem[] {
	const legacy = asRecord(value.legacy);
	if (!legacy || !(value.rest_id || legacy.id_str) || !hasCompleteText(value)) return [];
	return parseBookmarksPage({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ entries: [{
		entryId: `tweet-${value.rest_id ?? legacy.id_str}`,
		content: { itemContent: { tweet_results: { result: value } } },
	}] }] } } } }, { importedAt: now }).items;
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

function fromDocument(id: string, doc: Document, now: number): NormalizedItem | undefined {
	const links = [...doc.querySelectorAll("a[href]")];
	const link = links.find((a) => href(a, "https://x.com")?.match(/\/status\/(\d+)/)?.[1] === id && a.querySelector("time"));
	const root = link?.closest("article");
	if (!root || root.querySelector('[data-testid="tweet-text-show-more-link"]')) return;
	const primary = root.querySelector('a[href*="/status/"]:has(time)');
	if (href(primary, "https://x.com")?.match(/\/status\/(\d+)/)?.[1] !== id) return;
	const text = postText(root.querySelector('[data-testid="tweetText"]'));
	if (!text || root.querySelectorAll('[data-testid="tweetText"]').length > 1) return;
	const url = href(link ?? null, "https://x.com")!;
	return { source: "x", externalId: id, savedAt: now, savedAtIsExact: true, metrics: {}, links: [], raw: {}, kind: "post", url,
		body: text, authorHandle: new URL(url).pathname.split("/")[1],
		media: [...root.querySelectorAll('[data-testid="tweetPhoto"] img')].map((image) => ({ kind: "image" as const, originUrl: image.getAttribute("src") ?? "" })).filter((m) => m.originUrl.startsWith("https://")) };
}

const nativeSnapshot: NativeSnapshotAdapter = {
	parseObject,
	matchesIdentity,
	hasCompleteProviderData,
	sanitize,
	fromDocument,
	idsFromClickTarget(root) {
		return [...root.querySelectorAll("a[href]")].slice(0, 100)
			.map((link) => href(link)?.match(/\/status\/(\d+)/)?.[1])
			.filter((id): id is string => Boolean(id));
	},
};

export const xCaptureAdapter = {
	source: "x",
	hosts: ["x.com", "twitter.com"],
	tabPatterns: ["https://x.com/*", "https://twitter.com/*"],
	entryUrl: "https://x.com/i/bookmarks",
	importMode: "page",
	refreshTopOnResume: true,
	isExternalId: (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value),
	canonicalUrl: (id: string) => tweetUrl(id),
	parsePage: (raw: unknown, importedAt: number) => nativeItemsFromPayloadWithAdapter("x", raw, importedAt, nativeSnapshot),
	isExpectedImportTab(value: string) {
		try { const url = new URL(value); return (url.hostname === "x.com" || url.hostname === "twitter.com") && url.pathname.replace(/\/+$/, "") === "/i/bookmarks"; }
		catch { return false; }
	},
	protocol: {
		events: { actions: ["ready", "saved", "bookmark", "page", "done", "error"], ready: "query-or-relay", pageRequiresRunId: true, doneRequiresRunId: true, errorRequiresRunId: true },
		commands: { actions: ["configure", "backfill"], requiredRunIdActions: ["backfill"] },
	},
	nativeSnapshot,
} satisfies PlatformCaptureAdapter<"x">;

