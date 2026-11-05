import { describe, expect, test } from "bun:test";
import {
	connectionForWxtConfig,
	createExtensionConnectionStore,
	resolveExtensionBuildMode,
	validateExtensionConnection,
	type ExtensionConnectionStorage,
} from "./connection.ts";

const validOrigin = "https://anansi.example";
const validToken = "0123456789abcdef";

describe("runtime extension connection validation", () => {
	test("normalizes the server origin and masks credentials in errors", () => {
		const connection = validateExtensionConnection(
			" HTTPS://Example.COM:443/library ",
			` ${validToken} `,
		);

		expect(connection).toEqual({
			origin: "https://example.com",
			token: validToken,
		});
		expect(Object.isFrozen(connection)).toBe(true);

		const secret = "this-secret-must-never-be-printed";
		expect(() => validateExtensionConnection("not a URL", secret)).toThrow(
			"Server origin",
		);
		expect(() => validateExtensionConnection(validOrigin, "short")).toThrow(
			"Ingest token",
		);
	});

	test("allows loopback HTTP but rejects unsafe origins", () => {
		for (const [origin, expected] of [
			["http://127.0.0.1:3001/path", "http://127.0.0.1:3001"],
			["http://localhost:3001/path", "http://localhost:3001"],
			["http://[::1]:3001/path", "http://[::1]:3001"],
		] as const) {
			expect(validateExtensionConnection(origin, validToken).origin).toBe(
				expected,
			);
		}

		for (const origin of [
			"http://anansi.example.com",
			"https://person:secret@example.com",
			"file:///tmp/anansi",
			"not a URL",
		]) {
			expect(() => validateExtensionConnection(origin, validToken)).toThrow(
				"Server origin",
			);
		}
	});
});

describe("public and private WXT build modes", () => {
	test("public is the default and ignores configured deployment credentials", () => {
		expect(resolveExtensionBuildMode(undefined)).toBe("public");
		for (const command of ["prepare", "dev", "build", "zip"]) {
			expect(
				connectionForWxtConfig(validOrigin, validToken, command),
			).toBeNull();
			expect(
				connectionForWxtConfig(validOrigin, validToken, command, "public"),
			).toBeNull();
		}
	});

	test("private artifacts require a valid configured connection", () => {
		expect(
			connectionForWxtConfig(validOrigin, validToken, "build", "private"),
		).toEqual({ origin: validOrigin, token: validToken });
		expect(() =>
			connectionForWxtConfig(undefined, undefined, "build", "private"),
		).toThrow("Server origin");
	});

	test("prepare can generate types without a configured private connection", () => {
		expect(
			connectionForWxtConfig(undefined, undefined, "prepare", "private"),
		).toBeNull();
	});

	test("rejects unrecognized mode values", () => {
		for (const value of ["configured", "true", "PRIVATE"]) {
			expect(() => resolveExtensionBuildMode(value)).toThrow(
				"ANANSI_EXTENSION_BUILD_MODE",
			);
		}
	});
});

describe("trusted extension connection storage", () => {
	function makeStorage() {
		const values: Record<string, unknown> = {};
		const operations: string[] = [];
		const storage: ExtensionConnectionStorage = {
			async get(keys) {
				operations.push("get");
				const requested = Array.isArray(keys) ? keys : [keys];
				return Object.fromEntries(
					requested
						.filter((key) => key in values)
						.map((key) => [key, values[key]]),
				);
			},
			async set(next) {
				operations.push("set");
				Object.assign(values, next);
			},
			async remove(keys) {
				operations.push("remove");
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					delete values[key];
				}
			},
			async setAccessLevel(options) {
				operations.push(`access:${options.accessLevel}`);
			},
		};
		return { storage, values, operations };
	}

	test("restricts storage to trusted extension contexts before reading or writing", async () => {
		const { storage, operations } = makeStorage();
		const store = createExtensionConnectionStore(storage, () => null);
		await store.get();
		await store.save(validOrigin, validToken);

		expect(operations[0]).toBe("access:TRUSTED_CONTEXTS");
		expect(operations.filter((operation) => operation.startsWith("access:")))
			.toHaveLength(1);
	});

	test("save stores a validated runtime connection and clears the disconnected marker", async () => {
		const { storage, values } = makeStorage();
		values.anansiConnectionExplicitlyDisconnected = true;
		const store = createExtensionConnectionStore(storage, () => null);

		expect(await store.save(validOrigin, validToken)).toEqual({
			origin: validOrigin,
			token: validToken,
		});
		expect(values.anansiConnection).toEqual({
			origin: validOrigin,
			token: validToken,
		});
		expect(values.anansiConnectionExplicitlyDisconnected).toBeUndefined();
		expect(await store.get()).toEqual({ origin: validOrigin, token: validToken });
	});

	test("disconnect persists suppression of private fallback before removing credentials", async () => {
		const { storage, values } = makeStorage();
		let fallbackCalls = 0;
		const store = createExtensionConnectionStore(storage, () => {
			fallbackCalls += 1;
			return { origin: validOrigin, token: validToken };
		});
		await store.save(validOrigin, validToken);
		await store.clear();

		expect(values.anansiConnection).toBeUndefined();
		expect(values.anansiConnectionExplicitlyDisconnected).toBe(true);
		expect(await store.get()).toBeNull();
		expect(fallbackCalls).toBe(0);
	});

	test("a malformed stored connection does not silently select a private fallback", async () => {
		const { storage, values } = makeStorage();
		values.anansiConnection = { origin: validOrigin, token: "short" };
		const store = createExtensionConnectionStore(storage, () => ({
			origin: validOrigin,
			token: validToken,
		}));

		expect(await store.get()).toBeNull();
	});

	test("still works where the browser has no access-level API", async () => {
		const { storage } = makeStorage();
		delete storage.setAccessLevel;
		const store = createExtensionConnectionStore(storage, () => null);

		expect(await store.get()).toBeNull();
	});
});
