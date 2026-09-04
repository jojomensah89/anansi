import { describe, expect, test } from "bun:test";
import {
	HEARTBEAT_SCHEMA_VERSION,
	parseExtensionHeartbeat,
	type ExtensionHeartbeat,
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

	test("accepts GitHub source health", () => {
		expect(
			parseExtensionHeartbeat({
				...valid(),
				sources: { github: valid().sources.x },
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
