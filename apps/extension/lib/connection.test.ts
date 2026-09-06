import { describe, expect, test } from "bun:test";
import {
	connectionForWxtConfig,
	validateExtensionConnection,
} from "./connection.ts";

describe("private extension connection", () => {
	test("normalizes the one public Anansi origin", () => {
		const connection = validateExtensionConnection(
			" HTTPS://Example.COM:443/library ",
			" 0123456789abcdef ",
		);

		expect(connection).toEqual({
			origin: "https://example.com",
			token: "0123456789abcdef",
		});
		expect(Object.isFrozen(connection)).toBe(true);
	});

	test("allows loopback HTTP but rejects unsafe origins", () => {
		expect(
			validateExtensionConnection(
				"http://127.0.0.1:3001/path",
				"0123456789abcdef",
			).origin,
		).toBe("http://127.0.0.1:3001");

		for (const origin of [
			"http://anansi.example.com",
			"https://person:secret@example.com",
			"file:///tmp/anansi",
			"not a URL",
		]) {
			expect(() =>
				validateExtensionConnection(origin, "0123456789abcdef"),
			).toThrow("ANANSI_EXTENSION_ORIGIN");
		}
	});

	test("fails without a real ingest credential and never echoes it", () => {
		for (const token of [undefined, "", "too-short"]) {
			expect(() =>
				validateExtensionConnection("https://anansi.example", token),
			).toThrow("ANANSI_EXTENSION_INGEST_TOKEN");
		}

		const secret = "this-secret-must-never-be-printed";
		try {
			validateExtensionConnection("not a URL", secret);
			throw new Error("expected validation failure");
		} catch (error) {
			expect(String(error)).not.toContain(secret);
		}
	});
});

describe("WXT command configuration", () => {
	test("prepare can generate types before deployment is configured", () => {
		expect(connectionForWxtConfig(undefined, undefined, "prepare")).toEqual({
			origin: "http://127.0.0.1",
			token: "prepare-only-placeholder",
		});
	});

	test("artifact-producing commands still fail closed", () => {
		for (const command of ["dev", "build", "zip"]) {
			expect(() => connectionForWxtConfig(undefined, undefined, command)).toThrow(
				"ANANSI_EXTENSION_ORIGIN",
			);
		}
	});
});
