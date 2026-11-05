import { describe, expect, test } from "bun:test";
import {
	collectConfiguredCredentialValues,
	validatePublicArtifactContents,
} from "./check-public-artifact.mjs";

const manifest = {
	manifest_version: 3,
	permissions: [
		"activeTab",
		"alarms",
		"contextMenus",
		"scripting",
		"storage",
		"tabs",
	],
	optional_permissions: ["bookmarks"],
	host_permissions: [
		"https://x.com/*",
		"https://twitter.com/*",
		"https://www.reddit.com/*",
		"https://old.reddit.com/*",
		"https://reddit.com/*",
		"https://github.com/*",
		"https://www.tiktok.com/*",
		"https://tiktok.com/*",
	],
	optional_host_permissions: [
		"https://*/*",
		"http://localhost/*",
		"http://127.0.0.1/*",
		"http://[::1]/*",
	],
};

function fixture(bundle = "export const ready = true;") {
	return new Map([
		["manifest.json", Buffer.from(JSON.stringify(manifest))],
		["background.js", Buffer.from(bundle)],
	]);
}

describe("public Chrome artifact validator", () => {
	test("accepts a credential-free MV3 artifact with expected permissions", () => {
		expect(() => validatePublicArtifactContents(fixture())).not.toThrow();
	});

	test("rejects all configured deployment credentials without printing values", () => {
		const credentialFixtures = [
			["ANANSI_EXTENSION_ORIGIN", "https://private.example"],
			["ANANSI_EXTENSION_INGEST_TOKEN", "a-private-extension-ingest-token"],
			["ANANSI_SECRET", "a-private-master-secret-value"],
			["LIBRARY_TOKEN", "a-private-library-token-value"],
			["INGEST_TOKEN", "a-private-ingest-token-value"],
			["MCP_TOKEN", "a-private-mcp-token-value"],
		] as const;
		for (const [name, secret] of credentialFixtures) {
			for (const source of ["root .env", "process environment"] as const) {
				const dotenvValues = source === "root .env" ? { [name]: secret } : {};
				const environmentValues = source === "process environment" ? { [name]: secret } : {};
				const configured = collectConfiguredCredentialValues(
					dotenvValues,
					environmentValues,
				);
				expect(configured).toContainEqual({ name, value: secret });
				try {
					validatePublicArtifactContents(
						fixture(`const value = "${secret}";`),
						configured,
					);
					throw new Error("expected credential rejection");
				} catch (error) {
					expect(String(error)).toContain(name);
					expect(String(error)).not.toContain(secret);
				}
			}
		}
	});

	test("rejects unexpected or broader manifest permissions", () => {
		const files = fixture();
		files.set(
			"manifest.json",
			Buffer.from(
				JSON.stringify({ ...manifest, permissions: [...manifest.permissions, "cookies"] }),
			),
		);
		expect(() => validatePublicArtifactContents(files)).toThrow(
			"unexpected required permission",
		);
	});
});
