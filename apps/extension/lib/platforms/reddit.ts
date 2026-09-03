/**
 * What the extension knows about Reddit, kept away from the page.
 *
 * Reddit is easier than X in one way and harder in another. Easier: the save
 * endpoints are plain REST and say what they do in the path. Harder: they
 * answer with nothing useful, and a fullname on its own is not a link — a
 * comment's permalink cannot be derived from `t1_abc` without knowing the post
 * it hangs under.
 *
 * So a mutation here is read in two steps: the request says what happened, and
 * `/api/info` says what it happened to. That second call returns the same
 * listing shape the server parser already handles, which is why noticing a
 * save needs no new parser anywhere.
 */

export type SaveAction = "save" | "unsave";
export type RedditKind = "post" | "comment";

export interface SaveMutation {
	action: SaveAction;
	fullname: string;
	kind: RedditKind;
}

const FULLNAME = /^t[135]_[a-z0-9]{1,20}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(fullname: string): RedditKind | null {
	if (fullname.startsWith("t3_")) return "post";
	if (fullname.startsWith("t1_")) return "comment";
	return null;
}

/**
 * The action, from the path.
 *
 * `/api/unsave` also contains "save", so the negative is tested first; getting
 * that order wrong records every removal as an addition.
 */
function actionOf(url: string): SaveAction | null {
	let path: string;
	try {
		path = new URL(url, "https://www.reddit.com").pathname.replace(/\/+$/, "");
	} catch {
		return null;
	}
	if (path.endsWith("/unsave")) return "unsave";
	if (path.endsWith("/save")) return "save";
	return null;
}

/** Reddit sends this as a form body, a URLSearchParams, FormData or JSON. */
function readId(body: unknown): string | null {
	if (typeof body === "string") {
		try {
			const parsed: unknown = JSON.parse(body);
			if (isRecord(parsed)) return readId(parsed);
		} catch {
			// Much more often it is form-encoded, which is the next attempt.
		}
		const params = new URLSearchParams(body);
		return params.get("id");
	}
	if (body instanceof URLSearchParams) return body.get("id");
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		const value = body.get("id");
		return typeof value === "string" ? value : null;
	}
	if (isRecord(body)) {
		const value = body.id;
		return typeof value === "string" ? value : null;
	}
	return null;
}

export function readSaveMutation(url: string, body: unknown): SaveMutation | null {
	const action = actionOf(url);
	if (!action) return null;
	const id = readId(body);
	if (!id || !FULLNAME.test(id)) return null;
	const kind = kindOf(id.toLowerCase());
	return kind ? { action, fullname: id.toLowerCase(), kind } : null;
}

// ---- what it happened to --------------------------------------------------

export interface RedditObject {
	fullname: string;
	canonicalUrl: string;
}

type Any = Record<string, any>;

function permalinkUrl(permalink: unknown): string | null {
	if (typeof permalink !== "string" || !permalink.startsWith("/")) return null;
	try {
		const url = new URL(permalink, "https://www.reddit.com");
		return url.hostname === "www.reddit.com" ? url.toString() : null;
	} catch {
		return null;
	}
}

/**
 * Find one object in an `/api/info` listing.
 *
 * The listing is the same envelope as a saved page, so the shape is already
 * proven by the server parser; this only pulls out the permalink the capture
 * needs to name a canonical location.
 */
export function readInfoObject(raw: unknown, fullname: string): RedditObject | null {
	const children = (raw as Any)?.data?.children;
	if (!Array.isArray(children)) return null;
	for (const child of children as Any[]) {
		const data = child?.data;
		if (!data) continue;
		const name = typeof data.name === "string" ? data.name.toLowerCase() : null;
		if (name !== fullname.toLowerCase()) continue;
		const canonicalUrl = permalinkUrl(data.permalink);
		if (!canonicalUrl) return null;
		return { fullname: name, canonicalUrl };
	}
	return null;
}

export function infoUrl(fullname: string): string | null {
	if (!FULLNAME.test(fullname)) return null;
	return `https://www.reddit.com/api/info.json?id=${encodeURIComponent(fullname.toLowerCase())}&raw_json=1`;
}

// ---- being told to wait ---------------------------------------------------

/**
 * How long Reddit asked for, bounded.
 *
 * Reddit is stricter than X about rate limits and says so in a header. An
 * unbounded wait read from a response is a page that never finishes; a
 * discarded one is a run that gets itself throttled harder.
 */
export function retryAfterMs(
	status: number,
	retryAfter: string | null,
	limits: { min?: number; max?: number } = {},
): number | null {
	if (status !== 429 && status !== 503) return null;
	const min = limits.min ?? 1_000;
	const max = limits.max ?? 120_000;
	const seconds = Number(retryAfter);
	const wait =
		Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 10_000;
	return Math.min(Math.max(wait, min), max);
}
