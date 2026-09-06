import { DOMParser } from "linkedom/worker";
import {
	extractGitHubStarsPage,
	validatedGitHubStarsPageUrl,
} from "./platforms/github.ts";

export type SessionSource = "github" | "reddit";
export type SessionImportErrorCode =
	| "not_signed_in"
	| "rate_limited"
	| "page_shape_changed"
	| "platform_request_failed";

export class SessionImportError extends Error {
	constructor(
		readonly code: SessionImportErrorCode,
		readonly retryAfterMs?: number,
	) {
		super(code);
	}
}

function retryDelay(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.min(24 * 60 * 60_000, Math.max(60_000, seconds * 1000));
	const at = Date.parse(value);
	return Number.isFinite(at)
		? Math.min(24 * 60 * 60_000, Math.max(60_000, at - Date.now()))
		: undefined;
}

export interface SessionPage {
	raw: unknown;
	items: number;
	cursor: string | null;
}

export interface SessionImportOptions {
	source: SessionSource;
	cursor?: string;
	pageLimit: number;
	live: boolean;
	signal: AbortSignal;
	/** False when paused, replaced, or disabled by the server. */
	isCurrent(): Promise<boolean>;
	/** Must resolve only after this page and its cursor are durable. */
	onPage(page: SessionPage, number: number): Promise<void>;
	fetcher?: typeof globalThis.fetch;
}

export interface SessionImportResult {
	state: "complete" | "limited" | "cancelled";
	pages: number;
	items: number;
}

const GITHUB = "https://github.com/stars";
const REDDIT = "https://www.reddit.com";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(): never {
	throw new SessionImportError("page_shape_changed");
}

/** Requests are built here, never supplied by a page or remote configuration. */
async function responseText(
	url: string,
	accept: string,
	options: SessionImportOptions,
): Promise<string> {
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]);
	const response = await (options.fetcher ?? fetch)(url, {
		method: "GET",
		credentials: "include",
		redirect: "manual",
		cache: "no-store",
		headers: { accept },
		signal,
	});
	// Do not follow a session redirect to login/SSO or another host.
	if (
		response.type === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400) ||
		response.status === 401
	)
		throw new SessionImportError("not_signed_in");
	if (response.status === 429 || response.status === 503)
		throw new SessionImportError(
			"rate_limited",
			retryDelay(response.headers.get("retry-after")),
		);
	if (!response.ok) throw new SessionImportError("platform_request_failed");
	const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
	if (mime !== accept) shapeError();
	if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES)
		shapeError();
	const reader = response.body?.getReader();
	if (!reader) shapeError();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) shapeError();
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function json(
	url: string,
	options: SessionImportOptions,
): Promise<unknown> {
	const text = await responseText(url, "application/json", options);
	try {
		return JSON.parse(text);
	} catch {
		return shapeError();
	}
}

async function githubPage(
	url: string,
	options: SessionImportOptions,
): Promise<SessionPage> {
	const validated = validatedGitHubStarsPageUrl(url, GITHUB);
	if (!validated || new URL(validated).port) shapeError();
	const html = await responseText(validated, "text/html", options);
	// This parser does not execute scripts or load images/iframes. Only the
	// bounded repository records leave the worker, never the session HTML.
	const document = new DOMParser().parseFromString(html, "text/html");
	const result = extractGitHubStarsPage(
		document as unknown as Document,
		validated,
	);
	if (result.kind === "signed_out")
		throw new SessionImportError("not_signed_in");
	if (result.kind === "page_shape_changed") shapeError();
	return {
		raw: result.page,
		items: result.page.repositories.length,
		cursor: result.page.nextUrl ?? null,
	};
}

function redditCursor(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !/^t[13]_[a-z0-9]{1,20}$/i.test(value))
		shapeError();
	return value;
}

async function redditHandle(options: SessionImportOptions): Promise<string> {
	const raw = await json(`${REDDIT}/api/me.json`, options);
	const name = record(raw) && record(raw.data) ? raw.data.name : undefined;
	if (typeof name !== "string" || !/^[\w-]{1,32}$/.test(name))
		throw new SessionImportError("not_signed_in");
	return name;
}

async function redditPage(
	handle: string,
	cursor: string | null,
	options: SessionImportOptions,
): Promise<SessionPage> {
	const url = new URL(`/user/${encodeURIComponent(handle)}/saved.json`, REDDIT);
	url.searchParams.set("limit", options.live ? "20" : "100");
	url.searchParams.set("raw_json", "1");
	if (cursor) url.searchParams.set("after", redditCursor(cursor) as string);
	const raw = await json(url.toString(), options);
	if (!record(raw) || raw.kind !== "Listing" || !record(raw.data)) shapeError();
	const children = raw.data.children;
	if (!Array.isArray(children) || children.length > 100) shapeError();
	if (
		children.some(
			(child) =>
				!record(child) ||
				!["t1", "t3"].includes(String(child.kind)) ||
				!record(child.data),
		)
	)
		shapeError();
	const next = redditCursor(raw.data.after);
	if (children.length === 0 && next) shapeError();
	return { raw, items: children.length, cursor: next };
}

/** One bounded history walk. No tab, cookie-reading, or page-message APIs. */
export async function runSessionImport(
	options: SessionImportOptions,
): Promise<SessionImportResult> {
	let pages = 0;
	let items = 0;
	const current = async () =>
		!options.signal.aborted && (await options.isCurrent());
	const cancelled = (): SessionImportResult => ({
		state: "cancelled",
		pages,
		items,
	});
	if (!(await current())) return cancelled();
	let cursor = options.live ? null : (options.cursor ?? null);
	const handle =
		options.source === "reddit" ? await redditHandle(options) : null;
	const seen = new Set<string>();
	const limit = options.live
		? 1
		: Math.max(1, Math.min(40, Math.floor(options.pageLimit) || 40));
	for (;;) {
		if (!(await current())) return cancelled();
		const position = cursor ?? "initial";
		if (seen.has(position)) shapeError();
		seen.add(position);
		const page =
			options.source === "github"
				? await githubPage(cursor ?? GITHUB, options)
				: await redditPage(handle as string, cursor, options);
		if (!(await current())) return cancelled();
		if (page.cursor && (page.cursor === cursor || seen.has(page.cursor)))
			shapeError();
		await options.onPage(page, pages + 1);
		pages++;
		items += page.items;
		if (!(await current())) return cancelled();
		if (!page.cursor || options.live)
			return { state: "complete", pages, items };
		if (pages >= limit) return { state: "limited", pages, items };
		cursor = page.cursor;
	}
}
