import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { parse as parseDotenv } from "dotenv";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(extensionDir, "../..");
const packageJson = JSON.parse(
	await readFile(join(extensionDir, "package.json"), "utf8"),
);
const outputDir = join(extensionDir, ".output", "public");
const buildDir = join(outputDir, "chrome-mv3");
const zipPath = join(
	outputDir,
	`anansi-${packageJson.version}-chrome-public.zip`,
);

const expectedPermissions = [
	"activeTab",
	"alarms",
	"contextMenus",
	"scripting",
	"storage",
	"tabs",
];
const expectedOptionalPermissions = ["bookmarks"];
const expectedHostPermissions = [
	"https://x.com/*",
	"https://twitter.com/*",
	"https://www.reddit.com/*",
	"https://old.reddit.com/*",
	"https://reddit.com/*",
	"https://github.com/*",
	"https://www.tiktok.com/*",
	"https://tiktok.com/*",
];
const expectedOptionalHostPermissions = [
	"https://*/*",
	"http://localhost/*",
	"http://127.0.0.1/*",
	"http://[::1]/*",
];

function sameMembers(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		[...actual].sort().every((entry, index) => entry === [...expected].sort()[index])
	);
}

function findEndOfCentralDirectory(buffer) {
	const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
	for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
	}
	throw new Error("Public Chrome ZIP is missing its directory footer");
}

export function readZipEntries(buffer) {
	const footer = findEndOfCentralDirectory(buffer);
	const entryCount = buffer.readUInt16LE(footer + 10);
	const directorySize = buffer.readUInt32LE(footer + 12);
	let offset = buffer.readUInt32LE(footer + 16);
	if (
		entryCount === 0xffff ||
		directorySize === 0xffffffff ||
		offset === 0xffffffff
	) {
		throw new Error("Public Chrome ZIP uses an unsupported ZIP64 directory");
	}
	if (offset + directorySize > buffer.length) {
		throw new Error("Public Chrome ZIP directory is outside the archive");
	}

	const entries = new Map();
	for (let index = 0; index < entryCount; index += 1) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error("Public Chrome ZIP has an invalid directory entry");
		}
		const flags = buffer.readUInt16LE(offset + 8);
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer
			.subarray(offset + 46, offset + 46 + nameLength)
			.toString("utf8");
		if (flags & 1) throw new Error("Public Chrome ZIP contains encrypted files");
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
			throw new Error("Public Chrome ZIP contains an unsupported ZIP64 file");
		}
		if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
			throw new Error("Public Chrome ZIP has an invalid local entry");
		}
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
		const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
		let contents;
		if (method === 0) contents = Buffer.from(compressed);
		else if (method === 8) contents = inflateRawSync(compressed);
		else throw new Error("Public Chrome ZIP uses an unsupported compression method");
		if (contents.length !== uncompressedSize) {
			throw new Error("Public Chrome ZIP entry size does not match its directory");
		}
		if (!name.endsWith("/")) entries.set(name, contents);
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

export function collectConfiguredCredentialValues(dotenvValues, environmentValues) {
	const values = { ...dotenvValues, ...environmentValues };
	const checks = [];
	for (const [name, value] of [
		["ANANSI_EXTENSION_ORIGIN", values.ANANSI_EXTENSION_ORIGIN],
		["ANANSI_EXTENSION_INGEST_TOKEN", values.ANANSI_EXTENSION_INGEST_TOKEN],
		["ANANSI_SECRET", values.ANANSI_SECRET],
		["LIBRARY_TOKEN", values.LIBRARY_TOKEN],
		["INGEST_TOKEN", values.INGEST_TOKEN],
		["MCP_TOKEN", values.MCP_TOKEN],
	]) {
		if (typeof value !== "string" || value.length === 0) continue;
		checks.push({ name, value });
		const trimmed = value.trim();
		if (trimmed && trimmed !== value) checks.push({ name, value: trimmed });
		if (name === "ANANSI_EXTENSION_ORIGIN") {
			try {
				const normalized = new URL(trimmed).origin;
				if (normalized !== trimmed) checks.push({ name, value: normalized });
			} catch {
				// The build rejects invalid origins; their supplied text is still checked.
			}
		}
	}
	return checks;
}

function environmentCredentialValues() {
	let dotenvValues = {};
	try {
		dotenvValues = parseDotenv(readFileSync(join(repositoryRoot, ".env"), "utf8"));
	} catch {
		// A missing root .env is expected on CI and clean public builds.
	}
	return collectConfiguredCredentialValues(dotenvValues, process.env);
}

function assertPublicManifest(contents, label) {
	let manifest;
	try {
		manifest = JSON.parse(contents.toString("utf8"));
	} catch {
		throw new Error(`${label} has an unreadable manifest.json`);
	}
	if (manifest.manifest_version !== 3) {
		throw new Error(`${label} is not a Manifest V3 extension`);
	}
	if (!sameMembers(manifest.permissions, expectedPermissions)) {
		throw new Error(`${label} has an unexpected required permission`);
	}
	if (!sameMembers(manifest.optional_permissions, expectedOptionalPermissions)) {
		throw new Error(`${label} has an unexpected optional permission`);
	}
	if (!sameMembers(manifest.host_permissions, expectedHostPermissions)) {
		throw new Error(`${label} has an unexpected required host permission`);
	}
	if (!sameMembers(manifest.optional_host_permissions, expectedOptionalHostPermissions)) {
		throw new Error(`${label} has an unexpected optional host permission`);
	}
}

export function validatePublicArtifactContents(files, credentials = []) {
	if (!files.has("manifest.json")) {
		throw new Error("Public Chrome artifact is missing manifest.json");
	}
	assertPublicManifest(files.get("manifest.json"), "Public Chrome artifact");

	for (const [name, contents] of files) {
		for (const credential of credentials) {
			const needle = Buffer.from(credential.value);
			if (needle.length > 0 && contents.includes(needle)) {
				throw new Error(
					`Public Chrome artifact embeds configured ${credential.name}`,
				);
			}
		}
		if (
			contents.includes(Buffer.from("unconfigured-placeholder-token")) ||
			contents.includes(Buffer.from("prepare-only-placeholder")) ||
			contents.includes(Buffer.from("ci-build-placeholder"))
		) {
			throw new Error("Public Chrome artifact contains a build placeholder");
		}
		if (name.includes("..")) {
			throw new Error("Public Chrome ZIP contains an unsafe entry path");
		}
	}
}

async function readDirectoryFiles(directory, relativeTo = directory) {
	const files = new Map();
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			for (const [name, contents] of await readDirectoryFiles(path, relativeTo)) {
				files.set(name, contents);
			}
		} else if (entry.isFile()) {
			const name = path.slice(relativeTo.length + 1).replaceAll("\\", "/");
			files.set(name, await readFile(path));
		}
	}
	return files;
}

async function main() {
	const credentials = environmentCredentialValues();
	const directoryFiles = await readDirectoryFiles(buildDir);
	validatePublicArtifactContents(directoryFiles, credentials);

	const zipEntries = readZipEntries(await readFile(zipPath));
	validatePublicArtifactContents(zipEntries, credentials);
	console.log("Public Chrome build and ZIP passed manifest and credential checks.");
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	await main();
}
