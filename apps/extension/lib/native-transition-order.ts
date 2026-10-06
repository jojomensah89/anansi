export interface NativeTransitionConfirmation {
	/** Resolves true if the confirmation had to be released by its timeout. */
	timedOut: Promise<boolean>;
	/** Returns false when this transition was already settled or timed out. */
	confirm(callback: () => void): boolean;
	fail(): void;
}

export interface NativeTransitionReservation {
	/** Resolves when an unknown request identity is discarded by its timeout. */
	expired: Promise<void>;
	bind(itemId: string): NativeTransitionConfirmation | null;
	skip(): void;
}

interface TransitionEntry {
	order: number;
	settled: boolean;
	callback?: () => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface NativeTransitionOrderOptions {
	/** Maximum time an unparsed request body can hold up later mutations. */
	identityTimeoutMs?: number;
	/** Maximum time a bound mutation can hold later transitions for that item. */
	confirmationTimeoutMs?: number;
	setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimeout?: (handle: TimerHandle) => void;
}

/**
 * Keep successful native bookmark observations in request-start order for
 * each item. Unknown request bodies and unobserved responses have bounded
 * leases: an abandoned page stream must never hold the ordering queue forever.
 */
export function createNativeTransitionOrder(options: NativeTransitionOrderOptions = {}) {
	const identityTimeoutMs = options.identityTimeoutMs ?? 2_000;
	const confirmationTimeoutMs = options.confirmationTimeoutMs ?? 15_000;
	const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
	let nextOrder = 0;
	const unresolved = new Set<number>();
	const queues = new Map<string, TransitionEntry[]>();

	const drain = (itemId: string) => {
		const queue = queues.get(itemId);
		if (!queue) return;

		for (;;) {
			const first = queue[0];
			if (!first || !first.settled) break;
			if ([...unresolved].some((order) => order < first.order)) break;
			queue.shift();
			try {
				first.callback?.();
			} catch {
				// An observation must never affect the page's request flow.
			}
		}

		if (queue.length === 0) queues.delete(itemId);
	};

	const drainAll = () => {
		for (const itemId of queues.keys()) drain(itemId);
	};

	return {
		reserve(): NativeTransitionReservation {
			const order = ++nextOrder;
			unresolved.add(order);
			let resolved = false;
			let resolveExpired!: () => void;
			const expired = new Promise<void>((resolve) => {
				resolveExpired = resolve;
			});
			const releaseUnresolved = () => {
				unresolved.delete(order);
				drainAll();
			};
			const identityTimer = schedule(() => {
				if (resolved) return;
				resolved = true;
				releaseUnresolved();
				resolveExpired();
			}, identityTimeoutMs);

			return {
				expired,
				bind(itemId) {
					if (resolved) return null;
					resolved = true;
					cancel(identityTimer);
					unresolved.delete(order);
					const entry: TransitionEntry = { order, settled: false };
					const queue = queues.get(itemId) ?? [];
					queue.push(entry);
					queue.sort((left, right) => left.order - right.order);
					queues.set(itemId, queue);
					drainAll();

					let settled = false;
					let resolveTimedOut!: (timedOut: boolean) => void;
					const timedOut = new Promise<boolean>((resolve) => {
						resolveTimedOut = resolve;
					});
					const settle = (callback: (() => void) | undefined, timeout: boolean) => {
						if (settled) return false;
						settled = true;
						cancel(confirmationTimer);
						entry.settled = true;
						entry.callback = callback;
						resolveTimedOut(timeout);
						drain(itemId);
						return true;
					};
					const confirmationTimer = schedule(
						() => settle(undefined, true),
						confirmationTimeoutMs,
					);

					return {
						timedOut,
						confirm: (callback: () => void) => settle(callback, false),
						fail: () => settle(undefined, false),
					};
				},
				skip() {
					if (resolved) return;
					resolved = true;
					cancel(identityTimer);
					releaseUnresolved();
				},
			};
		},
	};
}
