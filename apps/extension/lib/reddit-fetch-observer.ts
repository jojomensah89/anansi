/** Observe saves without delaying or changing the site's fetch result. */
export function observeRedditFetch(
	nativeFetch: typeof fetch,
	matches: (url: string) => boolean,
	note: (url: string, body: unknown, ok: boolean) => void,
): typeof fetch {
	const patched = function (this: unknown, ...args: Parameters<typeof fetch>) {
		let observation: { url: string; body: Promise<unknown> } | undefined;
		try {
			const input = args[0];
			const url = input instanceof Request ? input.url : String(input);
			const method =
				args[1]?.method ?? (input instanceof Request ? input.method : "GET");
			if (method.toUpperCase() === "POST" && matches(url)) {
				// Native fetch consumes Request bodies. Clone a watched request
				// before forwarding it, and read only the clone asynchronously.
				const body =
					args[1]?.body !== undefined
						? Promise.resolve(args[1].body)
						: input instanceof Request
							? input.clone().text()
							: Promise.resolve(null);
				observation = { url, body: body.catch(() => null) };
			}
		} catch {
			// Failure to observe must not alter Reddit's network operation.
		}
		const result = nativeFetch.apply(this, args);
		if (observation) {
			const { url, body } = observation;
			void result
				.then(async (response) => {
					if (response.ok) note(url, await body, true);
				})
				.catch(() => {});
		}
		// Preserve the original promise, response, rejection, and request args.
		return result;
	};
	return Object.assign(patched, nativeFetch) as typeof fetch;
}
