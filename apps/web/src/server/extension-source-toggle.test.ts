import { expect, test } from "bun:test";
import { parseExtensionConfig } from "@anansi/sources";
import type { AnansiDb } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { popupSourceRows } from "../../../extension/lib/popup-connection.ts";
import { requestSourceToggle } from "../../../extension/lib/source-toggle.ts";
import { handleApi } from "./api.ts";
import { createClient } from "./clients.ts";

/**
 * The popup's switch against the real route table: the extension's own request
 * code sends it, and the config it then reads goes through the same parser the
 * extension uses. A 200 alone has hidden a broken contract before.
 */
test("the popup's switch round-trips through the server and the extension's parser", async () => {
	const local = openLocalDb(":memory:");
	migrateLocalDb(local);
	const env = { db: local as unknown as AnansiDb, libraryToken: "owner-test", ingestToken: "legacy-test" };
	const { key } = await createClient(env.db, "Browser", "extension");
	const transport = ((url: string, init?: RequestInit) => handleApi(env, new Request(url, init))) as unknown as typeof fetch;
	const connection = { server: "https://library.test", token: key };

	const readConfig = async () => {
		const response = await handleApi(env, new Request("https://library.test/api/extension/config", { headers: { authorization: `Bearer ${key}` } }));
		const parsed = parseExtensionConfig(await response.json());
		if (!parsed.ok) throw new Error(parsed.error.message);
		return parsed.config;
	};

	expect(await requestSourceToggle(connection, "tiktok", false, transport)).toEqual({ ok: true, source: "tiktok", enabled: false });
	const off = await readConfig();
	expect(off.sources.map((source) => source.source)).not.toContain("tiktok");
	// The popup's rows: TikTok is still listed, switched off, with a switch.
	const rows = popupSourceRows(off.sources);
	expect(rows.find((row) => row.source === "tiktok")).toMatchObject({ enabled: false, configured: false, toggleable: true });
	expect(rows.filter((row) => row.source !== "tiktok").every((row) => row.enabled && row.toggleable)).toBe(true);
	// Offline, the last accepted config is what the switch remembers.
	expect(popupSourceRows(null, off.sources).find((row) => row.source === "tiktok")?.enabled).toBe(false);

	expect(await requestSourceToggle(connection, "tiktok", true, transport)).toEqual({ ok: true, source: "tiktok", enabled: true });
	expect((await readConfig()).sources.find((source) => source.source === "tiktok")).toMatchObject({ mode: "observe" });

	// A key the library never issued cannot flip anything.
	const revoked = { ...connection, token: "anansi_not-a-key" };
	expect(await requestSourceToggle(revoked, "x", false, transport)).toEqual({ ok: false, error: "Key rejected" });
	expect((await readConfig()).sources.map((source) => source.source)).toContain("x");
});
