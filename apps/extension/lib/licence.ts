/**
 * The licence check for the prebuilt store extension.
 *
 * The code is free; only the store build asks for a key. Public and private
 * builds construct this with `required: false` and every answer is
 * "not-applicable", so they never read, store or send anything.
 *
 * Everything here is pure over its injected fetch, clock and storage, so the
 * whole policy is testable without a browser or the real Polar API:
 *
 * - A key is activated once per browser (Polar allows 5 activations).
 * - It is revalidated at most once every 7 days.
 * - A failed check that is not a definitive answer (offline, 5xx, timeouts)
 *   never locks anyone out: the licence keeps working for 30 days after the
 *   last successful check.
 * - Only a 404 on validate (revoked, or the activation is gone), or 30 days
 *   with no successful check at all, makes it invalid.
 */

export const POLAR_API = "https://api.polar.sh/v1/customer-portal/license-keys";
export const POLAR_ORGANIZATION_ID = "5178b60c-1d06-401f-a59b-59d3b81d097d";
export const LICENCE_CHECKOUT_URL =
	"https://buy.polar.sh/polar_cl_23HStXNgQMfXFavpX5s33s4PzRtZuNxJU1WWl0cIfgF";

export const LICENCE_STORAGE_KEY = "anansiLicence";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const REVALIDATE_AFTER_MS = 7 * DAY_MS;
export const GRACE_MS = 30 * DAY_MS;
/** While in grace, a background retry is attempted at most this often. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_KEY_LENGTH = 256;

export interface StoredLicence {
	readonly key: string;
	readonly activationId: string;
	readonly displayKey: string;
	readonly activatedAt: number;
	readonly lastValidatedAt: number;
	/** Set only by a definitive answer from Polar; never by a network failure. */
	readonly revoked?: true;
	/** Last attempt of any outcome, so grace retries are not hammered. */
	readonly lastAttemptAt?: number;
}

export type LicenceGate =
	| { readonly state: "not-applicable" }
	| { readonly state: "required" }
	| { readonly state: "active"; readonly displayKey: string; readonly lastValidatedAt: number }
	| {
			readonly state: "grace";
			readonly displayKey: string;
			readonly lastValidatedAt: number;
			readonly graceEndsAt: number;
	  }
	| {
			readonly state: "invalid";
			readonly displayKey: string;
			/** revoked: Polar said no. unverified: no successful check for 30 days. */
			readonly reason: "revoked" | "unverified";
	  };

export type LicenceError = "empty" | "not-found" | "limit" | "revoked" | "offline";

export type LicenceResult =
	| { readonly ok: true; readonly gate: LicenceGate }
	| { readonly ok: false; readonly error: LicenceError; readonly gate: LicenceGate };

export interface LicenceStorage {
	get(key: string): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

export type LicenceFetch = (
	url: string,
	init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface LicenceDependencies {
	/** True only for the store build. */
	readonly required: boolean;
	readonly fetch: LicenceFetch;
	readonly now: () => number;
	readonly storage: LicenceStorage;
	/** A label for this activation, such as "Chrome · 2026-11-12". No personal data. */
	readonly label?: () => string;
	readonly organizationId?: string;
	readonly timeoutMs?: number;
}

/** Captures and uploads may run in these states; queued work waits in the others. */
export function licenceAllowsCapture(gate: LicenceGate): boolean {
	return gate.state === "not-applicable" || gate.state === "active" || gate.state === "grace";
}

/** One line per failure, for the popup. */
export function licenceErrorMessage(error: LicenceError): string {
	switch (error) {
		case "empty":
			return "Paste your licence key";
		case "not-found":
			return "No licence matches that key. Check it and try again";
		case "limit":
			return "Already active in 5 browsers. Free one from the Polar customer portal";
		case "revoked":
			return "This key was revoked or has expired";
		case "offline":
			return "Couldn't reach the licence server. Check you're online and try again";
	}
}

/** "Chrome · 2026-11-12": which browser and when, nothing that identifies a person. */
export function activationLabel(userAgent: string, now: number): string {
	const browserName = /Edg\//.test(userAgent)
		? "Edge"
		: /OPR\//.test(userAgent)
			? "Opera"
			: /Brave/.test(userAgent)
				? "Brave"
				: /Firefox\//.test(userAgent)
					? "Firefox"
					: /Chrome\//.test(userAgent)
						? "Chrome"
						: "Browser";
	return `${browserName} · ${new Date(now).toISOString().slice(0, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStored(value: unknown): StoredLicence | null {
	if (!isRecord(value)) return null;
	const { key, activationId, displayKey, activatedAt, lastValidatedAt, revoked, lastAttemptAt } = value;
	if (
		typeof key !== "string" ||
		!key ||
		typeof activationId !== "string" ||
		!activationId ||
		typeof displayKey !== "string" ||
		typeof activatedAt !== "number" ||
		typeof lastValidatedAt !== "number"
	) {
		return null;
	}
	return {
		key,
		activationId,
		displayKey,
		activatedAt,
		lastValidatedAt,
		...(revoked === true ? { revoked: true as const } : {}),
		...(typeof lastAttemptAt === "number" ? { lastAttemptAt } : {}),
	};
}

/** The gate for a stored record at a moment. Pure. */
export function gateFor(stored: StoredLicence | null, now: number): LicenceGate {
	if (!stored) return { state: "required" };
	const { displayKey, lastValidatedAt } = stored;
	if (stored.revoked) return { state: "invalid", displayKey, reason: "revoked" };
	const age = now - lastValidatedAt;
	if (age <= REVALIDATE_AFTER_MS) return { state: "active", displayKey, lastValidatedAt };
	if (age <= GRACE_MS) {
		return { state: "grace", displayKey, lastValidatedAt, graceEndsAt: lastValidatedAt + GRACE_MS };
	}
	return { state: "invalid", displayKey, reason: "unverified" };
}

/** Polar's NotPermitted covers both a full activation limit and a dead key. */
function notPermittedReason(body: unknown): LicenceError {
	const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : "";
	if (/limit/i.test(detail)) return "limit";
	if (/revoked|disabled|expired|no longer|not active|inactive/i.test(detail)) return "revoked";
	return "limit";
}

export function createLicence(deps: LicenceDependencies) {
	const organizationId = deps.organizationId ?? POLAR_ORGANIZATION_ID;
	const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

	const read = async (): Promise<StoredLicence | null> => {
		const values = await deps.storage.get(LICENCE_STORAGE_KEY);
		return parseStored(values[LICENCE_STORAGE_KEY]);
	};
	const write = (stored: StoredLicence) => deps.storage.set({ [LICENCE_STORAGE_KEY]: stored });

	/** null means no answer at all: offline, timed out, or the request threw. */
	const post = async (
		path: "activate" | "validate" | "deactivate",
		body: Record<string, unknown>,
	): Promise<{ status: number; body: unknown } | null> => {
		const controller = typeof AbortController === "undefined" ? null : new AbortController();
		const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
		try {
			const response = await deps.fetch(`${POLAR_API}/${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body),
				...(controller ? { signal: controller.signal } : {}),
			});
			const parsed = response.status === 204 ? null : await response.json().catch(() => null);
			return { status: response.status, body: parsed };
		} catch {
			return null;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	const notApplicable: LicenceGate = { state: "not-applicable" };

	async function licenceGate(): Promise<LicenceGate> {
		if (!deps.required) return notApplicable;
		return gateFor(await read(), deps.now());
	}

	async function activateLicence(rawKey: string): Promise<LicenceResult> {
		if (!deps.required) return { ok: true, gate: notApplicable };
		const key = rawKey.trim();
		const fail = async (error: LicenceError): Promise<LicenceResult> => ({
			ok: false,
			error,
			gate: await licenceGate(),
		});
		if (!key) return fail("empty");
		if (key.length > MAX_KEY_LENGTH) return fail("not-found");

		const now = deps.now();
		const answer = await post("activate", {
			key,
			organization_id: organizationId,
			label: deps.label?.() ?? activationLabel("", now),
		});
		if (!answer) return fail("offline");
		if (answer.status === 404 || answer.status === 422) return fail("not-found");
		if (answer.status === 403) return fail(notPermittedReason(answer.body));
		if (answer.status < 200 || answer.status >= 300) return fail("offline");

		const body = answer.body;
		const licenceKey = isRecord(body) && isRecord(body.license_key) ? body.license_key : null;
		const activationId = isRecord(body) && typeof body.id === "string" ? body.id : "";
		if (!licenceKey || !activationId) return fail("offline");
		if (licenceKey.status !== "granted") return fail("revoked");

		const displayKey =
			typeof licenceKey.display_key === "string" && licenceKey.display_key
				? licenceKey.display_key
				: `****-${key.slice(-4)}`;
		const stored: StoredLicence = {
			key,
			activationId,
			displayKey,
			activatedAt: now,
			lastValidatedAt: now,
			lastAttemptAt: now,
		};
		await write(stored);
		return { ok: true, gate: gateFor(stored, now) };
	}

	/**
	 * Check the stored activation with Polar.
	 *
	 * Only a 404, or a 200 that is no longer granted, is definitive. Anything
	 * else leaves the record as it was, so the 30-day grace runs from the last
	 * success rather than from the failure.
	 */
	async function revalidate(): Promise<LicenceGate> {
		if (!deps.required) return notApplicable;
		const stored = await read();
		if (!stored || stored.revoked) return gateFor(stored, deps.now());

		const attemptedAt = deps.now();
		const answer = await post("validate", {
			key: stored.key,
			organization_id: organizationId,
			activation_id: stored.activationId,
		});
		const now = deps.now();
		// The record may have been removed or replaced while the request was out.
		const latest = await read();
		if (!latest || latest.activationId !== stored.activationId) return gateFor(latest, now);

		let next: StoredLicence = { ...latest, lastAttemptAt: attemptedAt };
		if (answer?.status === 200) {
			const granted = isRecord(answer.body) && answer.body.status === "granted";
			next = granted ? { ...next, lastValidatedAt: now } : { ...next, revoked: true };
		} else if (answer?.status === 404) {
			next = { ...next, revoked: true };
		}
		await write(next);
		return gateFor(next, now);
	}

	/**
	 * Revalidate only when it is due: once a week while active, and at most
	 * hourly while a check keeps failing. Safe to call on every wake-up.
	 */
	async function revalidateIfDue(): Promise<LicenceGate> {
		if (!deps.required) return notApplicable;
		const stored = await read();
		const now = deps.now();
		if (!stored || stored.revoked) return gateFor(stored, now);
		if (now - stored.lastValidatedAt <= REVALIDATE_AFTER_MS) return gateFor(stored, now);
		if (stored.lastAttemptAt !== undefined && now - stored.lastAttemptAt < RETRY_AFTER_FAILURE_MS) {
			return gateFor(stored, now);
		}
		return revalidate();
	}

	/**
	 * Free this browser's activation and forget the key.
	 *
	 * The local record is kept when Polar cannot be reached, so the slot is not
	 * silently lost: the person can try again once online.
	 */
	async function deactivate(): Promise<LicenceResult> {
		if (!deps.required) return { ok: true, gate: notApplicable };
		const stored = await read();
		if (!stored) return { ok: true, gate: { state: "required" } };
		const answer = await post("deactivate", {
			key: stored.key,
			organization_id: organizationId,
			activation_id: stored.activationId,
		});
		// 404: the activation is already gone, so there is nothing left to free.
		const freed = answer !== null && (answer.status === 204 || answer.status === 200 || answer.status === 404);
		if (!freed && !stored.revoked) {
			return { ok: false, error: "offline", gate: gateFor(stored, deps.now()) };
		}
		await deps.storage.remove(LICENCE_STORAGE_KEY);
		return { ok: true, gate: { state: "required" } };
	}

	return { licenceGate, activateLicence, revalidate, revalidateIfDue, deactivate };
}

export type Licence = ReturnType<typeof createLicence>;
