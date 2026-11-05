import type { OutboxRecord } from "./capture-queue.ts";

export interface LifecycleStorage {
	get(key: string): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

export const QUEUE_DESTINATION_KEY = "anansiQueueDestinationOrigin";
export const LEGACY_QUEUE_UNOWNED = "legacy_queue_unowned";
export const QUEUE_DESTINATION_MISMATCH = "queue_destination_mismatch";

/** Permission requests are part of connection success, never a best-effort hint. */
export async function requireOriginPermission(
	origin: string,
	permissions: {
		contains?: (details: { origins: string[] }) => Promise<boolean>;
		request?: (details: { origins: string[] }) => Promise<boolean>;
	},
): Promise<boolean> {
	if (!permissions.contains || !permissions.request) {
		throw new Error("Chrome could not request access to this Worker URL. Open the extension popup again and retry.");
	}
	const origins = [`${origin}/*`];
	const alreadyGranted = await permissions.contains({ origins });
	if (alreadyGranted) return true;
	const granted = await permissions.request({ origins });
	if (!granted) {
		throw new Error("Permission to access the Worker URL was denied. Allow the requested server access, then retry.");
	}
	return alreadyGranted;
}

/**
 * Keeps the durable outbox tied to the server that owned it when records were
 * admitted. The origin is metadata, never a credential. A serialized gate
 * prevents simultaneous captures from claiming different destinations.
 */
export function createQueueDestinationGuard(dependencies: {
	storage: LifecycleStorage;
	listRecords(): Promise<OutboxRecord[]>;
	hasPendingWork?(): Promise<boolean>;
	getOrigin(): Promise<string | null>;
	getProvenOrigin?(): Promise<string | null>;
}) {
	let operations: Promise<void> = Promise.resolve();
	const admissions = new Map<string, number>();
	const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = operations.then(operation);
		operations = result.then(() => undefined, () => undefined);
		return result;
	};

	const owner = async (): Promise<string | null> => {
		const value = (await dependencies.storage.get(QUEUE_DESTINATION_KEY))[
			QUEUE_DESTINATION_KEY
		];
		return typeof value === "string" ? value : null;
	};
	const hasRecords = async (): Promise<boolean> =>
		(await dependencies.listRecords()).length > 0 ||
		(await dependencies.hasPendingWork?.() ?? false);
	const activeOrigins = () => [...admissions].filter(([, count]) => count > 0).map(([origin]) => origin);

	return {
		async beginEnqueue(): Promise<
			| { ok: true; release(): Promise<void> }
			| { ok: false; error: string }
		> {
			return exclusive(async () => {
				const origin = await dependencies.getOrigin();
				if (!origin) {
					return { ok: false, error: "Connect to an Anansi server before capturing." };
				}
				const pending = await hasRecords();
				const currentOwner = await owner();
				if (
					(activeOrigins().some((active) => active !== origin)) ||
					(pending && currentOwner && currentOwner !== origin)
				) {
					return {
						ok: false,
						error: "Pending captures belong to a different Anansi server. Reconnect to that server and let the queue finish before switching.",
					};
				}
				if (!pending || !currentOwner) {
					await dependencies.storage.set({ [QUEUE_DESTINATION_KEY]: origin });
				}
				admissions.set(origin, (admissions.get(origin) ?? 0) + 1);
				let released = false;
				return {
					ok: true,
					async release() {
						if (released) return;
						released = true;
						await exclusive(async () => {
							const count = admissions.get(origin) ?? 0;
							if (count <= 1) admissions.delete(origin);
							else admissions.set(origin, count - 1);
						});
					},
				};
			});
		},
		async canDeliver(): Promise<boolean> {
			return exclusive(async () => {
				const active = activeOrigins();
				if (active.length > 0) {
					const origin = await dependencies.getOrigin();
					return Boolean(origin && active.includes(origin) && (await owner()) === origin);
				}
				const pending = await hasRecords();
				if (!pending) {
					await dependencies.storage.remove(QUEUE_DESTINATION_KEY);
					return false;
				}
				const origin = await dependencies.getOrigin();
				if (!origin) return false;
				const currentOwner = await owner();
				if (!currentOwner) {
					// An older outbox has no owner. Migrate only when prior committed
					// connection metadata proves this exact destination.
					if ((await dependencies.getProvenOrigin?.()) !== origin) return false;
					await dependencies.storage.set({ [QUEUE_DESTINATION_KEY]: origin });
					return true;
				}
				return currentOwner === origin;
			});
		},
		async canConnectTo(
			origin: string,
		): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
			return exclusive(async () => {
				const pending = await hasRecords();
				const currentOwner = await owner();
				if (!pending && currentOwner && activeOrigins().length === 0) {
					await dependencies.storage.remove(QUEUE_DESTINATION_KEY);
				}
				if (activeOrigins().some((active) => active !== origin)) {
					return { ok: false, code: QUEUE_DESTINATION_MISMATCH,
						error: "A capture is being committed for your current Anansi server. Wait for it to finish before switching." };
				}
				if (pending && currentOwner && currentOwner !== origin) {
					return {
						ok: false,
						code: QUEUE_DESTINATION_MISMATCH,
						error: "Pending captures belong to your current Anansi server. Retry or reconnect there until the queue is empty before switching servers.",
					};
				}
				if (pending && !currentOwner) {
					// A popup's current connection is provisional until this lifecycle
					// commit succeeds. Only worker-owned committed metadata can prove
					// where an older unowned queue previously belonged.
					const provenOrigin = await dependencies.getProvenOrigin?.();
					if (provenOrigin === origin) {
						await dependencies.storage.set({ [QUEUE_DESTINATION_KEY]: origin });
						return { ok: true };
					}
					return {
						ok: false,
						code: LEGACY_QUEUE_UNOWNED,
						error: "Older pending captures have no recorded server destination. Choose which server should receive them.",
					};
				}
				return { ok: true };
			});
		},
		async adoptCurrentOrigin(): Promise<{ ok: true } | { ok: false; error: string }> {
			return exclusive(async () => {
				const origin = await dependencies.getOrigin();
				if (!origin) return { ok: false, error: "Connect to an Anansi server first." };
			if (!(await hasRecords())) {
				await dependencies.storage.remove(QUEUE_DESTINATION_KEY);
				return { ok: false, error: "There are no pending captures to assign." };
			}
				const currentOwner = await owner();
				if (currentOwner) {
					return currentOwner === origin
						? { ok: true }
						: { ok: false, error: "These captures already belong to a different Anansi server." };
				}
				if (activeOrigins().some((active) => active !== origin)) {
					return { ok: false, error: "A capture is being committed for a different server. Try again when it finishes." };
				}
				await dependencies.storage.set({ [QUEUE_DESTINATION_KEY]: origin });
				return { ok: true };
			});
		},
		async clearIfEmpty(): Promise<void> {
			return exclusive(async () => {
				if (activeOrigins().length === 0 && !(await hasRecords())) {
					await dependencies.storage.remove(QUEUE_DESTINATION_KEY);
				}
			});
		},
	};
}
