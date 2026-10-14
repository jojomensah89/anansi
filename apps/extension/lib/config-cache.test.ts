import { describe, expect, test } from "bun:test";
import {
	type ConfigCacheStorage,
	cachedForServer,
	createPersistedConfigCache,
	normalizeServerOrigin,
	type ServerCache,
} from "./config-cache.ts";

const STORAGE_KEY = "anansiExtensionConfigCacheV1";

class MemoryStorage implements ConfigCacheStorage {
	readonly values: Record<string, unknown> = {};
	readonly removed: string[] = [];

	async get(key: string): Promise<Record<string, unknown>> {
		return key in this.values
			? { [key]: structuredClone(this.values[key]) }
			: {};
	}

	async set(values: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(values)) {
			this.values[key] = structuredClone(value);
		}
	}

	async remove(key: string): Promise<void> {
		this.removed.push(key);
		delete this.values[key];
	}
}

class BlockingRemoveStorage extends MemoryStorage {
	readonly removeStarted: Promise<void>;
	private readonly signalRemoveStarted: () => void;
	private readonly removeReleased: Promise<void>;
	readonly releaseRemove: () => void;

	constructor() {
		super();
		let signalRemoveStarted = () => {};
		this.removeStarted = new Promise<void>((resolve) => {
			signalRemoveStarted = resolve;
		});
		this.signalRemoveStarted = signalRemoveStarted;
		let releaseRemove = () => {};
		this.removeReleased = new Promise<void>((resolve) => {
			releaseRemove = resolve;
		});
		this.releaseRemove = releaseRemove;
	}

	override async remove(key: string): Promise<void> {
		this.signalRemoveStarted();
		await this.removeReleased;
		await super.remove(key);
	}
}

function validatedCache(storage = new MemoryStorage()) {
	return {
		storage,
		cache: createPersistedConfigCache<{ enabled: boolean }>({
			storage,
			validate: (value) => {
				if (!value || typeof value !== "object" || Array.isArray(value))
					return null;
				const enabled = (value as Record<string, unknown>).enabled;
				return typeof enabled === "boolean" ? { enabled } : null;
			},
		}),
	};
}

describe("extension config cache", () => {
	test("normalizes equivalent server addresses to one origin", () => {
		expect(normalizeServerOrigin(" HTTPS://Example.COM:443/path/ ")).toBe(
			"https://example.com",
		);
		expect(normalizeServerOrigin("http://localhost:8788///")).toBe(
			"http://localhost:8788",
		);
	});

	test("rejects unsupported or credential-bearing server addresses", () => {
		expect(normalizeServerOrigin("file:///tmp/anansi")).toBeNull();
		expect(normalizeServerOrigin("https://user:pass@example.com")).toBeNull();
		expect(normalizeServerOrigin("not a url")).toBeNull();
		expect(normalizeServerOrigin("http://anansi.example.com")).toBeNull();
	});

	test("never reuses one server's config for another server", () => {
		const cache: ServerCache<{ version: number }> = {
			serverOrigin: "https://one.example",
			at: 1_000,
			value: { version: 1 },
		};

		expect(
			cachedForServer(cache, "https://one.example/", 1_100, 1_000),
		).toEqual({
			version: 1,
		});
		expect(
			cachedForServer(cache, "https://two.example", 1_100, 1_000),
		).toBeNull();
	});

	test("uses stale fallback only for the same server", () => {
		const cache: ServerCache<string> = {
			serverOrigin: "http://localhost:8788",
			at: 0,
			value: "config-a",
		};

		expect(
			cachedForServer(cache, "http://localhost:8788", 10_000, 1_000),
		).toBeNull();
		expect(
			cachedForServer(cache, "http://localhost:8788", 10_000, 1_000, true),
		).toBe("config-a");
		expect(
			cachedForServer(cache, "http://localhost:9999", 10_000, 1_000, true),
		).toBeNull();
	});

	test("persists a validated config bound to the canonical origin and SHA-256 token fingerprint", async () => {
		const { cache, storage } = validatedCache();

		await expect(
			cache.save(
				" HTTPS://Example.COM:443/config ",
				"secret",
				{ enabled: true, ignored: "field" },
				1_000,
			),
		).resolves.toEqual({
			serverOrigin: "https://example.com",
			at: 1_000,
			value: { enabled: true },
		});
		expect(storage.values[STORAGE_KEY]).toEqual({
			version: 1,
			serverOrigin: "https://example.com",
			tokenFingerprint:
				"2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
			at: 1_000,
			value: { enabled: true },
		});
		expect(JSON.stringify(storage.values[STORAGE_KEY])).not.toContain("secret");
	});

	test("restores stale validated config after a worker restart for offline fallback", async () => {
		const storage = new MemoryStorage();
		await validatedCache(storage).cache.save(
			"https://example.com",
			"secret",
			{ enabled: true },
			1_000,
		);

		const restarted = validatedCache(storage).cache;
		const loaded = await restarted.load(
			"https://example.com/path",
			"secret",
			10_000,
		);

		expect(loaded).toEqual({
			serverOrigin: "https://example.com",
			at: 1_000,
			value: { enabled: true },
		});
		expect(
			cachedForServer(loaded, "https://example.com", 10_000, 1_000),
		).toBeNull();
		expect(
			cachedForServer(loaded, "https://example.com", 10_000, 1_000, true),
		).toEqual({ enabled: true });
	});

	test("treats another origin or token as a non-destructive cache miss", async () => {
		const { cache, storage } = validatedCache();
		await cache.save(
			"https://one.example",
			"token-one",
			{ enabled: true },
			3_000,
		);

		// A different identity must not erase this entry, even when its caller has
		// an earlier clock reading than the entry.
		expect(
			await cache.load("https://two.example", "token-one", 2_000),
		).toBeNull();
		expect(
			await cache.load("https://one.example", "token-two", 2_000),
		).toBeNull();
		expect(storage.removed).toEqual([]);
		expect(await cache.load("https://one.example", "token-one", 3_001)).toEqual(
			{
				serverOrigin: "https://one.example",
				at: 3_000,
				value: { enabled: true },
			},
		);
	});

	test.each([
		["non-object", "bad"],
		[
			"unknown version",
			{
				version: 2,
				serverOrigin: "https://example.com",
				tokenFingerprint: "0".repeat(64),
				at: 1_000,
				value: { enabled: true },
			},
		],
		[
			"non-canonical origin",
			{
				version: 1,
				serverOrigin: "https://example.com/path",
				tokenFingerprint: "0".repeat(64),
				at: 1_000,
				value: { enabled: true },
			},
		],
		[
			"invalid fingerprint",
			{
				version: 1,
				serverOrigin: "https://example.com",
				tokenFingerprint: "plaintext-token",
				at: 1_000,
				value: { enabled: true },
			},
		],
		[
			"extra field",
			{
				version: 1,
				serverOrigin: "https://example.com",
				tokenFingerprint: "0".repeat(64),
				at: 1_000,
				value: { enabled: true },
				extra: true,
			},
		],
	])(
		"rejects and removes a malformed persisted record: %s",
		async (_label, record) => {
			const { cache, storage } = validatedCache();
			storage.values[STORAGE_KEY] = record;

			expect(
				await cache.load("https://example.com", "secret", 2_000),
			).toBeNull();
			expect(storage.values[STORAGE_KEY]).toBeUndefined();
			expect(storage.removed).toEqual([STORAGE_KEY]);
		},
	);

	test("rejects and removes future-dated or payload-invalid records", async () => {
		const { cache, storage } = validatedCache();
		await cache.save("https://example.com", "secret", { enabled: true }, 2_000);

		expect(await cache.load("https://example.com", "secret", 1_999)).toBeNull();
		expect(storage.values[STORAGE_KEY]).toBeUndefined();

		await cache.save("https://example.com", "secret", { enabled: true }, 2_000);
		(storage.values[STORAGE_KEY] as { value: unknown }).value = {
			enabled: "yes",
		};
		expect(await cache.load("https://example.com", "secret", 2_001)).toBeNull();
		expect(storage.values[STORAGE_KEY]).toBeUndefined();
	});

	test("refuses invalid data before writing", async () => {
		const { cache, storage } = validatedCache();

		await expect(
			cache.save("https://example.com", "secret", { enabled: "yes" }, 1_000),
		).rejects.toThrow("invalid extension config cache entry");
		await expect(
			cache.save("http://example.com", "secret", { enabled: true }, 1_000),
		).rejects.toThrow("invalid extension config cache entry");
		await expect(
			cache.save("https://example.com", "secret", { enabled: true }, -1),
		).rejects.toThrow("invalid extension config cache entry");
		expect(storage.values).toEqual({});
	});

	test("auth invalidation clears only the matching origin and token", async () => {
		const { cache, storage } = validatedCache();
		await cache.save("https://example.com", "secret", { enabled: true }, 1_000);

		await cache.clear("https://other.example", "secret");
		await cache.clear("https://example.com", "other-token");
		expect(storage.values[STORAGE_KEY]).toBeDefined();

		await cache.clear("https://example.com/path", "secret");
		expect(storage.values[STORAGE_KEY]).toBeUndefined();
		expect(storage.removed).toEqual([STORAGE_KEY]);
	});

	test("serializes auth invalidation with a concurrent credential save", async () => {
		const storage = new BlockingRemoveStorage();
		const { cache } = validatedCache(storage);
		await cache.save(
			"https://example.com",
			"old-token",
			{ enabled: false },
			1_000,
		);

		const clearing = cache.clear("https://example.com", "old-token");
		await storage.removeStarted;
		const saving = cache.save(
			"https://example.com",
			"new-token",
			{ enabled: true },
			2_000,
		);
		storage.releaseRemove();
		await Promise.all([clearing, saving]);

		expect(await cache.load("https://example.com", "new-token", 2_001)).toEqual(
			{
				serverOrigin: "https://example.com",
				at: 2_000,
				value: { enabled: true },
			},
		);
	});
});
