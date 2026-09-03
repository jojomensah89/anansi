const TRACKING_PARAMETERS = new Set([
	"fbclid",
	"gclid",
	"dclid",
	"msclkid",
	"igshid",
	"mc_cid",
	"mc_eid",
]);

function supported(url: URL): boolean {
	return (
		(url.protocol === "http:" || url.protocol === "https:") &&
		url.username === "" &&
		url.password === ""
	);
}

/**
 * Produce a conservative identity URL. Unknown query parameters are content,
 * not tracking, until explicitly proven otherwise.
 */
export function canonicalizeWebUrl(
	input: string,
	canonicalCandidate?: string | null,
): string | null {
	let original: URL;
	try {
		original = new URL(input);
	} catch {
		return null;
	}
	if (!supported(original)) return null;

	let selected = original;
	if (canonicalCandidate) {
		try {
			const candidate = new URL(canonicalCandidate, original);
			if (supported(candidate) && candidate.origin === original.origin)
				selected = candidate;
		} catch {
			// A malformed canonical hint is decoration; the page URL remains valid.
		}
	}

	const result = new URL(selected.toString());
	result.hash = "";
	for (const key of [...result.searchParams.keys()]) {
		const normalized = key.toLowerCase();
		if (normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized)) {
			result.searchParams.delete(key);
		}
	}
	result.searchParams.sort();
	return result.toString();
}

/** Stable web-item identity that works in browsers and Bun without Node APIs. */
export async function webExternalId(canonicalUrl: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalUrl),
	);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}
