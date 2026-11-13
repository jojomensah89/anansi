import { describe, expect, test } from "bun:test";
import {
	activationLabel,
	createLicence,
	DAY_MS,
	gateFor,
	LICENCE_STORAGE_KEY,
	type LicenceFetch,
	licenceAllowsCapture,
	licenceErrorMessage,
	POLAR_API,
	POLAR_ORGANIZATION_ID,
	type StoredLicence,
} from "./licence.ts";
import { licenceRequiredForMode, resolveExtensionBuildMode } from "./connection.ts";

const KEY = "ANANSI-1111-2222-3333-4444";
const ACTIVATION = "8f3d1c62-6c6e-4d0e-9d5b-0a6a1f3b9c11";
const START = Date.UTC(2026, 10, 12, 9, 0, 0);

type Reply = { status: number; body?: unknown } | "network";

/** A fake Polar and a fake chrome.storage.local; nothing leaves the process. */
function harness(options: { required?: boolean; replies?: Reply[]; stored?: StoredLicence } = {}) {
	const values = new Map<string, unknown>();
	if (options.stored) values.set(LICENCE_STORAGE_KEY, options.stored);
	const replies = [...(options.replies ?? [])];
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	let now = START;

	const fetch: LicenceFetch = async (url, init) => {
		calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
		const reply = replies.shift();
		if (!reply) throw new Error("unexpected request");
		if (reply === "network") throw new TypeError("Failed to fetch");
		return { status: reply.status, json: async () => reply.body ?? null };
	};

	const licence = createLicence({
		required: options.required ?? true,
		fetch,
		now: () => now,
		storage: {
			get: async (key) => (values.has(key) ? { [key]: values.get(key) } : {}),
			set: async (next) => {
				for (const [key, value] of Object.entries(next)) values.set(key, value);
			},
			remove: async (key) => {
				values.delete(key);
			},
		},
		label: () => "Chrome · 2026-11-12",
	});

	return {
		licence,
		calls,
		stored: () => values.get(LICENCE_STORAGE_KEY) as StoredLicence | undefined,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const granted = {
	status: 200,
	body: {
		id: ACTIVATION,
		license_key: {
			status: "granted",
			display_key: "****-4444",
			limit_activations: 5,
			expires_at: null,
		},
	},
};

const activeRecord: StoredLicence = {
	key: KEY,
	activationId: ACTIVATION,
	displayKey: "****-4444",
	activatedAt: START,
	lastValidatedAt: START,
	lastAttemptAt: START,
};

describe("activateLicence", () => {
	test("a granted key is stored and the gate opens", async () => {
		const h = harness({ replies: [granted] });
		const result = await h.licence.activateLicence(`  ${KEY}\n`);

		expect(result).toEqual({
			ok: true,
			gate: { state: "active", displayKey: "****-4444", lastValidatedAt: START },
		});
		expect(h.calls).toEqual([
			{
				url: `${POLAR_API}/activate`,
				body: { key: KEY, organization_id: POLAR_ORGANIZATION_ID, label: "Chrome · 2026-11-12" },
			},
		]);
		expect(h.stored()).toEqual(activeRecord);
		expect(licenceAllowsCapture(await h.licence.licenceGate())).toBe(true);
	});

	test("403 for a full activation limit says so and stores nothing", async () => {
		const h = harness({
			replies: [{ status: 403, body: { error: "NotPermitted", detail: "License key activation limit already reached" } }],
		});
		const result = await h.licence.activateLicence(KEY);

		expect(result).toEqual({ ok: false, error: "limit", gate: { state: "required" } });
		expect(h.stored()).toBeUndefined();
		expect(licenceErrorMessage("limit")).toContain("5 browsers");
	});

	test("403 for a revoked key is reported as revoked", async () => {
		const h = harness({ replies: [{ status: 403, body: { error: "NotPermitted", detail: "License key is no longer active." } }] });
		expect(await h.licence.activateLicence(KEY)).toMatchObject({ ok: false, error: "revoked" });
	});

	test("404 is an unknown key", async () => {
		const h = harness({ replies: [{ status: 404, body: { error: "ResourceNotFound" } }] });
		expect(await h.licence.activateLicence(KEY)).toEqual({
			ok: false,
			error: "not-found",
			gate: { state: "required" },
		});
		expect(h.stored()).toBeUndefined();
	});

	test("422 for a malformed key reads the same as an unknown one", async () => {
		const h = harness({ replies: [{ status: 422 }] });
		expect(await h.licence.activateLicence("not a key")).toMatchObject({ ok: false, error: "not-found" });
	});

	test("a network failure is offline, not a verdict on the key", async () => {
		const h = harness({ replies: ["network"] });
		expect(await h.licence.activateLicence(KEY)).toEqual({
			ok: false,
			error: "offline",
			gate: { state: "required" },
		});
		expect(h.stored()).toBeUndefined();
	});

	test("a 5xx is offline too", async () => {
		const h = harness({ replies: [{ status: 503 }] });
		expect(await h.licence.activateLicence(KEY)).toMatchObject({ ok: false, error: "offline" });
	});

	test("an empty key never reaches Polar", async () => {
		const h = harness();
		expect(await h.licence.activateLicence("   ")).toMatchObject({ ok: false, error: "empty" });
		expect(h.calls).toEqual([]);
	});
});

describe("revalidate", () => {
	test("a granted answer renews the check", async () => {
		const h = harness({ stored: activeRecord, replies: [{ status: 200, body: { id: "k", status: "granted" } }] });
		h.advance(8 * DAY_MS);
		const gate = await h.licence.revalidate();

		expect(gate).toEqual({ state: "active", displayKey: "****-4444", lastValidatedAt: START + 8 * DAY_MS });
		expect(h.calls).toEqual([
			{
				url: `${POLAR_API}/validate`,
				body: { key: KEY, organization_id: POLAR_ORGANIZATION_ID, activation_id: ACTIVATION },
			},
		]);
	});

	test("404 means revoked or the activation is gone: invalid", async () => {
		const h = harness({ stored: activeRecord, replies: [{ status: 404 }] });
		h.advance(8 * DAY_MS);
		const gate = await h.licence.revalidate();

		expect(gate).toEqual({ state: "invalid", displayKey: "****-4444", reason: "revoked" });
		expect(licenceAllowsCapture(gate)).toBe(false);
		// The verdict sticks without asking again.
		expect(await h.licence.licenceGate()).toEqual(gate);
	});

	test("offline within 30 days keeps working in grace", async () => {
		const h = harness({ stored: activeRecord, replies: ["network"] });
		h.advance(10 * DAY_MS);
		const gate = await h.licence.revalidate();

		expect(gate).toEqual({
			state: "grace",
			displayKey: "****-4444",
			lastValidatedAt: START,
			graceEndsAt: START + 30 * DAY_MS,
		});
		expect(licenceAllowsCapture(gate)).toBe(true);
		// A failure never moves the last success.
		expect(h.stored()?.lastValidatedAt).toBe(START);
	});

	test("a 5xx within 30 days is grace, not a verdict", async () => {
		const h = harness({ stored: activeRecord, replies: [{ status: 500 }] });
		h.advance(20 * DAY_MS);
		expect((await h.licence.revalidate()).state).toBe("grace");
	});

	test("more than 30 days without a successful check is invalid", async () => {
		const h = harness({ stored: activeRecord, replies: ["network"] });
		h.advance(31 * DAY_MS);
		const gate = await h.licence.revalidate();

		expect(gate).toEqual({ state: "invalid", displayKey: "****-4444", reason: "unverified" });
		expect(licenceAllowsCapture(gate)).toBe(false);
	});

	test("an unverified licence comes back once a check succeeds", async () => {
		const h = harness({ stored: activeRecord, replies: [{ status: 200, body: { status: "granted" } }] });
		h.advance(45 * DAY_MS);
		expect((await h.licence.licenceGate()).state).toBe("invalid");
		expect((await h.licence.revalidate()).state).toBe("active");
	});

	test("revalidateIfDue asks Polar at most once a week", async () => {
		const h = harness({ stored: activeRecord, replies: [{ status: 200, body: { status: "granted" } }] });
		h.advance(6 * DAY_MS);
		expect((await h.licence.revalidateIfDue()).state).toBe("active");
		expect(h.calls).toHaveLength(0);

		h.advance(2 * DAY_MS);
		expect((await h.licence.revalidateIfDue()).state).toBe("active");
		expect(h.calls).toHaveLength(1);
	});

	test("while failing, revalidateIfDue retries at most hourly", async () => {
		const h = harness({ stored: activeRecord, replies: ["network", "network"] });
		h.advance(8 * DAY_MS);
		await h.licence.revalidateIfDue();
		await h.licence.revalidateIfDue();
		expect(h.calls).toHaveLength(1);

		h.advance(61 * 60 * 1000);
		await h.licence.revalidateIfDue();
		expect(h.calls).toHaveLength(2);
	});
});

describe("deactivate", () => {
	test("frees this browser's activation and forgets the key", async () => {
		const h = harness({ stored: activeRecord, replies: [{ status: 204 }] });
		expect(await h.licence.deactivate()).toEqual({ ok: true, gate: { state: "required" } });
		expect(h.calls).toEqual([
			{
				url: `${POLAR_API}/deactivate`,
				body: { key: KEY, organization_id: POLAR_ORGANIZATION_ID, activation_id: ACTIVATION },
			},
		]);
		expect(h.stored()).toBeUndefined();
	});

	test("offline keeps the key so the slot is not silently lost", async () => {
		const h = harness({ stored: activeRecord, replies: ["network"] });
		expect(await h.licence.deactivate()).toMatchObject({ ok: false, error: "offline", gate: { state: "active" } });
		expect(h.stored()).toEqual(activeRecord);
	});

	test("an activation Polar no longer knows is simply cleared", async () => {
		const h = harness({ stored: activeRecord, replies: [{ status: 404 }] });
		expect(await h.licence.deactivate()).toEqual({ ok: true, gate: { state: "required" } });
		expect(h.stored()).toBeUndefined();
	});
});

describe("builds that never ask", () => {
	test("public and private report the gate as not applicable and send nothing", async () => {
		for (const mode of ["public", "private"] as const) {
			const required = licenceRequiredForMode(resolveExtensionBuildMode(mode));
			expect(required).toBe(false);
			const h = harness({ required });
			expect(await h.licence.licenceGate()).toEqual({ state: "not-applicable" });
			expect(await h.licence.revalidateIfDue()).toEqual({ state: "not-applicable" });
			expect(await h.licence.activateLicence(KEY)).toEqual({ ok: true, gate: { state: "not-applicable" } });
			expect(await h.licence.deactivate()).toEqual({ ok: true, gate: { state: "not-applicable" } });
			expect(h.calls).toEqual([]);
			expect(h.stored()).toBeUndefined();
			expect(licenceAllowsCapture({ state: "not-applicable" })).toBe(true);
		}
	});

	test("only the store build requires a key", () => {
		expect(licenceRequiredForMode(resolveExtensionBuildMode(undefined))).toBe(false);
		expect(licenceRequiredForMode(resolveExtensionBuildMode("store"))).toBe(true);
	});

	test("the store build with no key is required, and blocks capture", async () => {
		const gate = await harness().licence.licenceGate();
		expect(gate).toEqual({ state: "required" });
		expect(licenceAllowsCapture(gate)).toBe(false);
	});
});

describe("helpers", () => {
	test("gateFor walks active, grace and invalid by age", () => {
		expect(gateFor(activeRecord, START + 7 * DAY_MS).state).toBe("active");
		expect(gateFor(activeRecord, START + 7 * DAY_MS + 1).state).toBe("grace");
		expect(gateFor(activeRecord, START + 30 * DAY_MS).state).toBe("grace");
		expect(gateFor(activeRecord, START + 30 * DAY_MS + 1).state).toBe("invalid");
	});

	test("an activation label names only the browser and the day", () => {
		const ua =
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
		expect(activationLabel(ua, START)).toBe("Chrome · 2026-11-12");
		expect(activationLabel(`${ua} Edg/141.0.0.0`, START)).toBe("Edge · 2026-11-12");
	});
});
