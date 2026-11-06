/**
 * Which relay nonce the worker expects from a page.
 *
 * Every page load starts a new relay with a new nonce, so a nonce belongs to a
 * document and not to a tab. Pinning it to the tab rejected everything after a
 * full navigation until the worker next restarted.
 *
 * Browsers without document ids fall back to the tab, where a relay announcing
 * itself replaces the old nonce. The relay refuses that announcement from the
 * page, and a page cannot message the worker directly.
 */
export interface NonceSender {
	tabId: number;
	documentId?: string;
}

const MAX_DOCUMENTS = 500;

export function isRelayAnnouncement(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const value = message as Record<string, unknown>;
	return value.anansi === "page-event" && value.action === "ready" && value.relay === true;
}

export function createDocumentNonces() {
	const known = new Map<string, string>();
	const keyOf = (sender: NonceSender) => sender.documentId ?? `tab:${sender.tabId}`;

	return {
		/** A sender not seen since the worker started can claim its own nonce. */
		expected(sender: NonceSender, message: unknown, claimed: string): string {
			if (isRelayAnnouncement(message)) return claimed;
			return known.get(keyOf(sender)) ?? claimed;
		},
		remember(sender: NonceSender, nonce: string) {
			// Forgetting is safe: the next event from a document claims again.
			if (known.size >= MAX_DOCUMENTS) known.clear();
			known.set(keyOf(sender), nonce);
		},
	};
}
