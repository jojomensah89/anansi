/**
 * What the extension knows about X, kept away from the page.
 *
 * Every function here is pure so the parts that are easy to get wrong — which
 * request is a save and which an unsave, when to stop paging, what may be
 * remembered from a request — can be tested without a browser or an account.
 *
 * The rule this module exists to enforce: a request template is a URL, never
 * headers. X's authorization bearer, its `ct0` CSRF value and its cookies live
 * in the page and stay there. Nothing that leaves here can carry them, because
 * nothing that leaves here has anywhere to put them.
 */

export type BookmarkAction = "save" | "unsave";

/** The operations X uses to add and remove a bookmark. */
const MUTATION_ACTIONS: Record<string, BookmarkAction> = {
	CreateBookmark: "save",
	DeleteBookmark: "unsave",
};

export interface BookmarkMutation {
	action: BookmarkAction;
	tweetId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** X ids are decimal snowflakes; anything else is not one. */
function asTweetId(value: unknown): string | null {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return String(value);
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return /^[0-9]{5,25}$/.test(trimmed) ? trimmed : null;
}

function operationOf(url: string): string | null {
	try {
		const path = new URL(url, "https://x.com").pathname;
		return path.split("/").filter(Boolean).pop() ?? null;
	} catch {
		return null;
	}
}

function parseBody(body: unknown): Record<string, unknown> | null {
	if (isRecord(body)) return body;
	if (typeof body !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(body);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Read a bookmark mutation into an explicit action and subject.
 *
 * The old code noticed both operations and reported the same word for each,
 * which is why unbookmarking something did nothing at all. The operation name
 * carries the action; the request body carries what it applies to.
 */
export function readBookmarkMutation(
	url: string,
	body: unknown,
): BookmarkMutation | null {
	const operation = operationOf(url);
	if (!operation) return null;
	const action = MUTATION_ACTIONS[operation];
	if (!action) return null;

	const parsed = parseBody(body);
	const variables =
		parsed && isRecord(parsed.variables) ? parsed.variables : null;
	if (!variables) return null;
	const tweetId = asTweetId(variables.tweet_id);
	return tweetId ? { action, tweetId } : null;
}

/**
 * Whether X actually applied the mutation.
 *
 * A 200 carrying an `errors` array is a refusal wearing a success code, and
 * acting on one records a save that never happened.
 */
export function isMutationAccepted(status: number, body: unknown): boolean {
	if (status < 200 || status >= 300) return false;
	const parsed = parseBody(body);
	if (!parsed) return false;
	if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return false;
	return isRecord(parsed.data);
}

export function tweetUrl(tweetId: string, screenName?: string): string {
	const handle =
		screenName && /^[A-Za-z0-9_]{1,15}$/.test(screenName) ? screenName : "i";
	return `https://x.com/${handle}/status/${tweetId}`;
}

// ---- timeline pages -------------------------------------------------------

export interface TimelinePageShape {
	cursorPrefix: string;
	entryPrefix: string;
}

export interface TimelinePage {
	cursor: string | null;
	items: number;
	ids: string[];
}

type Any = Record<string, any>;

/**
 * Both response variants the server parser already accepts.
 *
 * X served `bookmark_timeline` before `bookmark_timeline_v2`, and a stale
 * install can still receive either; reading only one is how an import quietly
 * returns zero items.
 */
function entriesOf(raw: unknown): Any[] {
	const root = raw as Any;
	const timeline =
		root?.data?.bookmark_timeline_v2?.timeline ??
		root?.data?.bookmark_timeline?.timeline;
	const instructions: Any[] = timeline?.instructions ?? [];
	for (const instruction of instructions) {
		if (Array.isArray(instruction?.entries)) return instruction.entries as Any[];
	}
	return [];
}

export function readTimelinePage(
	raw: unknown,
	shape: TimelinePageShape,
): TimelinePage {
	const entries = entriesOf(raw);
	const ids: string[] = [];
	let cursor: string | null = null;

	for (const entry of entries) {
		const entryId = String(entry?.entryId ?? "");
		if (entryId.startsWith(shape.cursorPrefix)) {
			const value = entry?.content?.value;
			if (!cursor && typeof value === "string" && value.length > 0) {
				cursor = value;
			}
			continue;
		}
		if (!entryId.startsWith(shape.entryPrefix)) continue;
		const id = asTweetId(entryId.slice(shape.entryPrefix.length));
		if (id) ids.push(id);
	}

	return { cursor, items: ids.length, ids };
}

// ---- request templates ----------------------------------------------------

/**
 * A Bookmarks request X made for itself, remembered as a URL.
 *
 * The previous import reconstructed this by hand and sent `features={}`,
 * which works right up until X requires a flag that is not in an empty
 * object. Copying the request the app just made successfully means the
 * feature set is always the one X currently wants, and it costs no guessing.
 */
export interface RequestTemplate {
	queryId: string;
	operation: string;
	variables: Record<string, unknown>;
	/** Opaque, forwarded exactly as X sent it. */
	features: string | null;
	fieldToggles: string | null;
}

const TEMPLATE_PATH = /^\/i\/api\/graphql\/([\w-]{5,64})\/([A-Za-z0-9_]{1,64})$/;

/**
 * Read a template out of a URL, and out of nothing else.
 *
 * There is no headers parameter by design: a template that cannot express a
 * header cannot leak one, however the caller is later changed.
 */
export function readRequestTemplate(
	url: string,
	operation: string,
): RequestTemplate | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	if (parsed.username !== "" || parsed.password !== "") return null;
	const host = parsed.hostname.toLowerCase();
	if (host !== "x.com" && host !== "twitter.com") return null;

	const match = TEMPLATE_PATH.exec(parsed.pathname);
	if (!match) return null;
	const [, queryId, found] = match;
	if (!queryId || found !== operation) return null;

	const rawVariables = parsed.searchParams.get("variables");
	if (!rawVariables) return null;
	let variables: unknown;
	try {
		variables = JSON.parse(rawVariables);
	} catch {
		return null;
	}
	if (!isRecord(variables)) return null;

	// The cursor is per-page, not part of the template.
	const { cursor: _cursor, ...rest } = variables;
	return {
		queryId,
		operation,
		variables: rest,
		features: parsed.searchParams.get("features"),
		fieldToggles: parsed.searchParams.get("fieldToggles"),
	};
}

export function buildTimelineUrl(
	template: RequestTemplate,
	cursor: string | null,
): string {
	const variables = cursor
		? { ...template.variables, cursor }
		: { ...template.variables };
	const url = new URL(
		`https://x.com/i/api/graphql/${template.queryId}/${template.operation}`,
	);
	url.searchParams.set("variables", JSON.stringify(variables));
	if (template.features !== null) {
		url.searchParams.set("features", template.features);
	}
	if (template.fieldToggles !== null) {
		url.searchParams.set("fieldToggles", template.fieldToggles);
	}
	return url.toString();
}

// ---- when to stop ---------------------------------------------------------

export type StopReason =
	| "empty_page"
	| "no_cursor"
	| "repeated_cursor"
	| "page_limit"
	| "known_overlap";

export interface StopInput {
	page: number;
	pageLimit: number;
	items: number;
	cursor: string | null;
	previousCursor: string | null;
	/** How many ids on this page were already known before the run. */
	knownOnPage?: number;
	/** Consecutive known ids carried in from earlier pages. */
	knownStreak?: number;
	/** 0 disables the overlap stop, which is what an initial import wants. */
	overlapThreshold?: number;
}

export interface StopDecision {
	stop: boolean;
	reason: StopReason | null;
	knownStreak: number;
}

/**
 * The four ordinary ends of a walk, plus the incremental one.
 *
 * Repeated-cursor earns its place: X answers a spent cursor with that same
 * cursor rather than an empty page, so a walk that only checks for zero items
 * never ends.
 */
export function shouldStopImport(input: StopInput): StopDecision {
	const threshold = input.overlapThreshold ?? 0;
	const known = input.knownOnPage ?? 0;
	// The streak only survives a page that was entirely familiar; one new item
	// means the boundary has not been reached yet.
	const streak =
		input.items > 0 && known >= input.items
			? (input.knownStreak ?? 0) + known
			: 0;

	if (input.items === 0) {
		return { stop: true, reason: "empty_page", knownStreak: streak };
	}
	if (threshold > 0 && streak >= threshold) {
		return { stop: true, reason: "known_overlap", knownStreak: streak };
	}
	if (input.page >= input.pageLimit) {
		return { stop: true, reason: "page_limit", knownStreak: streak };
	}
	if (!input.cursor) {
		return { stop: true, reason: "no_cursor", knownStreak: streak };
	}
	if (input.cursor === input.previousCursor) {
		return { stop: true, reason: "repeated_cursor", knownStreak: streak };
	}
	return { stop: false, reason: null, knownStreak: streak };
}
