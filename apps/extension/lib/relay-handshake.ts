/** Replay configuration once the document finishes starting its page scripts. */
export function createRelayHandshake<T>(send: (message: T) => void) {
	let latest: T | undefined;
	return {
		configure(message: T) {
			latest = message;
			send(message);
		},
		documentReady() {
			if (latest !== undefined) send(latest);
		},
	};
}
