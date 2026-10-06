/**
 * What the extension knows about Reddit, kept away from the page.
 *
 * Reddit's legacy save endpoints say what happened in the path; current
 * Shreddit uses a GraphQL mutation whose body names both the action and post.
 * A fullname on its own is not a link — a comment's permalink cannot be
 * derived from `t1_abc` without knowing the post it hangs under.
 *
 * So a mutation here is read in two steps: the request says what happened, and
 * `/api/info` says what it happened to. That second call returns the same
 * listing shape the server parser already handles, which is why noticing a
 * save needs no new parser anywhere.
 */

export type SaveAction = "save" | "unsave";
export type RedditKind = "post" | "comment";

interface SaveMutationBase {
	action: SaveAction;
	fullname: string;
	kind: RedditKind;
}

export type SaveMutation = SaveMutationBase &
	(
		| { transport: "legacy" }
		| { transport: "shreddit-graphql" }
	);

const FULLNAME = /^t[135]_[a-z0-9]{1,20}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(fullname: string): RedditKind | null {
	if (fullname.startsWith("t3_")) return "post";
	if (fullname.startsWith("t1_")) return "comment";
	return null;
}

function pathnameOf(url: string): string | null {
	let path: string;
	try {
		path = new URL(url, "https://www.reddit.com").pathname.replace(/\/+$/, "");
	} catch {
		return null;
	}
	return path;
}

/** True only for the Shreddit endpoint whose operation response must be checked. */
export function isRedditGraphqlEndpoint(url: string): boolean {
	return pathnameOf(url) === "/svc/shreddit/graphql";
}

/** The current Shreddit GraphQL endpoint and the legacy REST endpoints. */
export function isRedditMutationEndpoint(url: string): boolean {
	const path = pathnameOf(url);
	return (
		isRedditGraphqlEndpoint(url) ||
		path === "/svc/shreddit/save" ||
		path === "/api/save" ||
		path === "/api/unsave"
	);
}

/** GraphQL receipts identify a mutation even when its Request body is unreadable. */
export function needsRedditResponseBody(url: string, body: unknown): boolean {
	return isRedditGraphqlEndpoint(url) || readSaveMutation(url, body)?.transport === "shreddit-graphql";
}

/**
 * The action, from a legacy path.
 *
 * `/api/unsave` also contains "save", so the negative is tested first; getting
 * that order wrong records every removal as an addition.
 */
function actionOf(url: string): SaveAction | null {
	const path = pathnameOf(url);
	if (!path) return null;
	if (path === "/api/unsave") return "unsave";
	if (path === "/api/save" || path === "/svc/shreddit/save") return "save";
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
	const path = pathnameOf(url);
	if (path === "/svc/shreddit/graphql") {
		const request = readJsonRecord(body);
		if (request?.operation !== "UpdatePostSaveState") return null;
		const input = (request.variables as Record<string, unknown> | undefined)?.input;
		if (!isRecord(input)) return null;
		const id = input.postId;
		if (typeof id !== "string" || !FULLNAME.test(id)) return null;
		const fullname = id.toLowerCase();
		if (!fullname.startsWith("t3_")) return null;
		const saveState = input.saveState;
		if (saveState !== "SAVED" && saveState !== "NONE") return null;
		return {
			action: saveState === "SAVED" ? "save" : "unsave",
			fullname,
			kind: "post",
			transport: "shreddit-graphql",
		};
	}
	const action = actionOf(url);
	if (!action) return null;
	const id = readId(body);
	if (!id || !FULLNAME.test(id)) return null;
	const kind = kindOf(id.toLowerCase());
	return kind
		? { action, fullname: id.toLowerCase(), kind, transport: "legacy" }
		: null;
}

function readJsonRecord(body: unknown): Record<string, unknown> | null {
	if (typeof body === "string") {
		try {
			const parsed: unknown = JSON.parse(body);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return isRecord(body) ? body : null;
}

function hasNoErrors(value: unknown): boolean {
	return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/** A response can confirm a save even when the page-owned request body is unreadable. */
export function isRedditGraphqlSaveResponseAccepted(responseBody: unknown): boolean {
	const response = readJsonRecord(responseBody);
	if (!response || (response.operation !== undefined && response.operation !== "UpdatePostSaveState")) {
		return false;
	}
	if (!hasNoErrors(response.errors)) return false;
	const payload = (response.data as Record<string, unknown> | undefined)?.updatePostSaveState;
	return isRecord(payload) && payload.ok === true && hasNoErrors(payload.errors);
}

/** Refresh only when a Request clone failed and its response confirms a save-state mutation. */
export function shouldRefreshSavedListingAfterUnknownGraphqlMutation(
	requestBodyWasUnavailable: boolean,
	requestBody: unknown,
	responseBody: unknown,
): boolean {
	return requestBodyWasUnavailable && requestBody == null && isRedditGraphqlSaveResponseAccepted(responseBody);
}

/**
 * Legacy save endpoints report success through HTTP status alone. Shreddit's
 * GraphQL endpoint can return HTTP 200 for an unsuccessful mutation, so it
 * needs the mutation payload and an empty error list as well.
 */
export function isSaveMutationAccepted(
	mutation: SaveMutation,
	httpOk: boolean,
	responseBody?: unknown,
): boolean {
	if (!httpOk) return false;
	if (mutation.transport === "legacy") return true;
	return isRedditGraphqlSaveResponseAccepted(responseBody);
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
