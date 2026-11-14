import { describe, expect, test } from "bun:test";
import {
	type ExtensionHeartbeat,
	HEARTBEAT_SCHEMA_VERSION,
	parseExtensionHeartbeat,
} from "./extension-heartbeat.ts";

const valid = (): ExtensionHeartbeat => ({
	schemaVersion: HEARTBEAT_SCHEMA_VERSION,
	installationId: "123e4567-e89b-42d3-a456-426614174000",
	extensionVersion: "0.1.0",
	queue: { queued: 1, uploading: 0, retrying: 2, failed: 0 },
	sources: {
		x: {
			phase: "running",
			paused: false,
			lastErrorCode: "not_signed_in",
			queued: 1,
			uploading: 0,
			retrying: 0,
			failed: 0,
		},
	},
});

describe("parseExtensionHeartbeat", () => {
	test("drops newer source fields, including credential-shaped data", () => {
		const input = valid();
		const result = parseExtensionHeartbeat({ ...input, sources: {
			x: { ...input.sources.x, futureState: { enabled: true }, token: "never-store-this" },
		} });
		expect(result).toEqual({ ok: true, heartbeat: input });
		expect(JSON.stringify(result)).not.toContain("never-store-this");
	});

	test("unknown fields do not bypass known-field validation", () => {
		for (const invalid of [{ queued: -1 }, { phase: "finished" }, { paused: "yes" }, { lastCheckedAt: -1 }, { lastErrorCode: "Bearer secret" }]) {
			expect(parseExtensionHeartbeat({ ...valid(), sources: {
				x: { ...valid().sources.x, futureState: true, ...invalid },
			} }).ok).toBe(false);
		}
	});

	test("accepts the bounded operational envelope", () => {
		expect(parseExtensionHeartbeat(valid())).toEqual({
			ok: true,
			heartbeat: valid(),
		});
	});

	test("rejects unsupported versions and malformed identities", () => {
		expect(
			parseExtensionHeartbeat({ ...valid(), schemaVersion: 2 }),
		).toMatchObject({
			ok: false,
			error: { code: "unsupported_version" },
		});
		expect(
			parseExtensionHeartbeat({ ...valid(), installationId: "browser-one" }).ok,
		).toBe(false);
		expect(
			parseExtensionHeartbeat({ ...valid(), extensionVersion: "" }).ok,
		).toBe(false);
	});

	test("accepts shipped GitHub and Web source health", () => {
		expect(
			parseExtensionHeartbeat({
				...valid(),
				sources: { github: valid().sources.x },
			}).ok,
		).toBe(true);
		expect(
			parseExtensionHeartbeat({
				...valid(),
				sources: { web: valid().sources.x },
			}).ok,
		).toBe(true);
	});

	test("rejects invalid counts, sources, states, and extra fields", () => {
		expect(
			parseExtensionHeartbeat({
				...valid(),
				queue: { ...valid().queue, queued: -1 },
			}).ok,
		).toBe(false);
		expect(parseExtensionHeartbeat({ ...valid(), token: "secret" }).ok).toBe(
			false,
		);
		expect(
			parseExtensionHeartbeat({
				...valid(),
				sources: { instagram: valid().sources.x },
			}).ok,
		).toBe(false);
		expect(
			parseExtensionHeartbeat({
				...valid(),
				sources: { x: { ...valid().sources.x, phase: "finished" } },
			}).ok,
		).toBe(false);
	});

	test("never echoes supplied credential-shaped values", () => {
		const result = parseExtensionHeartbeat({
			...valid(),
			authorization: "Bearer top-secret",
		});
		expect(JSON.stringify(result)).not.toContain("top-secret");
	});
});
