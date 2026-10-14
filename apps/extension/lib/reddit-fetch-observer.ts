/** Observe saves without delaying or changing the site's fetch result. */
export interface RedditFetchObserverOptions {
	onRequestStart?: (
		url: string,
		body: Promise<unknown>,
		initialBody: { available: boolean; value: unknown },
	) => unknown;
	needsResponseBody?: (url: string, body: unknown) => boolean;
	/** Bound how long a page-owned Request clone may take to expose its body. */
	requestBodyTimeoutMs?: number;
	/** Bound response-body inspection; this side channel never blocks fetch. */
	responseBodyTimeoutMs?: number;
}

export interface RedditFetchObservationDetails {
	request?: unknown;
	responseBody?: unknown;
}

function bounded<T>(value: Promise<T>, timeoutMs: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		value.catch(() => null),
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), timeoutMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

interface RequestBodyReader {
	url: string;
	method: string;
	clone: () => { text: () => Promise<string> };
}

/** Cross-realm Request objects fail `instanceof Request` but remain readable. */
function requestBodyReader(value: unknown): RequestBodyReader | undefined {
	if (!value || typeof value !== "object") return;
	try {
		const candidate = value as Partial<RequestBodyReader>;
		if (
			typeof candidate.url === "string" &&
			typeof candidate.method === "string" &&
			typeof candidate.clone === "function"
		) {
			return candidate as RequestBodyReader;
		}
	} catch {
		// Host objects can expose throwing accessors; observation is best-effort.
	}
	return;
}

export function observeRedditFetch(
	nativeFetch: typeof fetch,
	matches: (url: string) => boolean,
	note: (
		url: string,
		body: unknown,
		ok: boolean,
		details?: RedditFetchObservationDetails,
	) => void,
	options: RedditFetchObserverOptions = {},
): typeof fetch {
	const patched = function (this: unknown, ...args: Parameters<typeof fetch>) {
		const requestBodyTimeoutMs = options.requestBodyTimeoutMs ?? 2_000;
		const responseBodyTimeoutMs = options.responseBodyTimeoutMs ?? 15_000;
		let observation:
			| {
				url: string;
				body: Promise<unknown>;
				initialBody: { available: boolean; value: unknown };
			}
			| undefined;
		let requestMetadata: unknown;
		try {
			const input = args[0];
			const requestInput =
				input instanceof Request ? input : requestBodyReader(input);
			const url = requestInput
				? requestInput.url
				: input instanceof URL
					? input.href
					: String(input);
			const method =
				args[1]?.method ?? requestInput?.method ?? "GET";
			if (method.toUpperCase() === "POST" && matches(url)) {
				// Native fetch consumes Request bodies. Clone a watched request
				// before forwarding it, and read only the clone asynchronously.
				let initialBody: { available: boolean; value: unknown };
				let body: Promise<unknown>;
				if (args[1]?.body !== undefined) {
					initialBody = { available: true, value: args[1].body };
					body = Promise.resolve(args[1].body).catch(() => null);
				} else if (requestInput) {
					initialBody = { available: false, value: null };
					body = requestInput.clone().text().catch(() => null);
				} else {
					initialBody = { available: true, value: null };
					body = Promise.resolve(null);
				}
				const boundedBody = bounded(body, requestBodyTimeoutMs);
				observation = { url, body: boundedBody, initialBody };
				try {
					requestMetadata = options.onRequestStart?.(
						url,
						boundedBody,
						initialBody,
					);
				} catch {
					// Failure to observe must not alter Reddit's network operation.
				}
			}
		} catch {
			// Failure to observe must not alter Reddit's network operation.
		}

		const notify = async (
			ok: boolean,
			responseBody?: unknown,
		) => {
			if (!observation) return;
			const body = await observation.body.catch(() => null);
			if (options.onRequestStart || options.needsResponseBody) {
				note(observation.url, body, ok, {
					...(requestMetadata === undefined ? {} : { request: requestMetadata }),
					...(responseBody === undefined ? {} : { responseBody }),
				});
			} else {
				note(observation.url, body, ok);
			}
		};

		let result: ReturnType<typeof nativeFetch>;
		try {
			result = nativeFetch.apply(this, args);
		} catch (error) {
			void notify(false).catch(() => {});
			throw error;
		}
		if (observation) {
			void result
				.then(async (response) => {
					if (!response.ok) {
						await notify(false);
						return;
					}
					// Clone before any await: returning the exact native promise lets
					// the page consume its response in the next continuation.
					let responseClone: Response | undefined;
					if (options.needsResponseBody) {
						try { responseClone = response.clone(); } catch { /* unreadable receipt */ }
					}
					let responseBody: unknown;
					let needsBody = false;
					try {
						needsBody =
							options.needsResponseBody?.(
								observation.url,
								await observation.body,
							) ?? false;
					} catch {
						needsBody = false;
					}
					if (needsBody) {
						try {
						const text = await bounded(
							responseClone ? responseClone.text() : Promise.resolve(null),
							responseBodyTimeoutMs,
						);
						responseBody = text === null ? null : JSON.parse(text);
						} catch {
							responseBody = null;
						}
					} else {
						void responseClone?.body?.cancel().catch(() => {});
					}
					await notify(true, responseBody);
				}, () => notify(false))
				.catch(() => {
					// Response inspection is a side channel; preserve fetch semantics.
					void notify(false).catch(() => {});
				});
		}
		// Preserve the original promise, response, rejection, and request args.
		return result;
	};
	return Object.assign(patched, nativeFetch) as typeof fetch;
}
