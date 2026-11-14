import type { ParseContext } from "../context.ts";
import type { MediaRef, NormalizedItem } from "../item.ts";

/**
 * Anansi-owned projection of fields a future page adapter may read from the
 * visible DOM. This is not an Instagram response shape or runtime fixture.
 * Unknown fields are rejected so provider requests, cookies, and credentials
 * cannot accidentally be persisted as `raw` data.
 */
export const INSTAGRAM_DOM_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface InstagramDomSnapshot {
	schemaVersion: typeof INSTAGRAM_DOM_SNAPSHOT_SCHEMA_VERSION;
	/** Stable content shortcode, repeated in the permalink for identity proof. */
	shortcode: string;
	permalink: string;
	caption: string;
	author: {
		handle: string;
		name?: string;
	};
	/** All visible image URLs, in display order; empty for poster-only items. */
	imageRefs: string[];
	/** Optional still image for a video. The video file itself is not captured. */
	videoPoster?: string;
}

const MAX_SHORTCODE_LENGTH = 64;
const MAX_URL_LENGTH = 2_000;
const MAX_CAPTION_LENGTH = 20_000;
const MAX_AUTHOR_NAME_LENGTH = 300;
const MAX_IMAGES = 100;
const SHORTCODE = /^[A-Za-z0-9_-]{1,64}$/;
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const SNAPSHOT_KEYS = new Set([
	"schemaVersion",
	"shortcode",
	"permalink",
	"caption",
	"author",
	"imageRefs",
	"videoPoster",
]);
const AUTHOR_KEYS = new Set(["handle", "name"]);

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		return Object.values(Object.getOwnPropertyDescriptors(value)).every(
			(descriptor) => "value" in descriptor && !descriptor.get && !descriptor.set,
		);
	} catch {
		return false;
	}
}

function hasOnlyKeys(value: PlainRecord, allowed: ReadonlySet<string>): boolean {
	try {
		return Reflect.ownKeys(value).every(
			(key) => typeof key === "string" && allowed.has(key),
		);
	} catch {
		return false;
	}
}

function dataArray(value: unknown, maxLength: number): unknown[] | null {
	if (!Array.isArray(value)) return null;
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
		if (!lengthDescriptor || !("value" in lengthDescriptor)) return null;
		const length: unknown = lengthDescriptor.value;
		const ownKeys = Reflect.ownKeys(value);
		if (
			!Number.isSafeInteger(length) ||
			Number(length) < 0 ||
			Number(length) > maxLength ||
			ownKeys.length !== Number(length) + 1
		) {
			return null;
		}
		const values: unknown[] = [];
		for (let index = 0; index < Number(length); index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
				return null;
			}
			values.push(descriptor.value);
		}
		return values;
	} catch {
		return null;
	}
}

function isBoundedText(
	value: unknown,
	maxLength: number,
	allowEmpty = false,
): value is string {
	return (
		typeof value === "string" &&
		value.length <= maxLength &&
		(allowEmpty || value.trim().length > 0)
	);
}

function canonicalPermalink(
	value: unknown,
	shortcode: string,
): { url: string; kind: "post" | "video" } | null {
	if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase()) ||
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			return null;
		}

		const match = /^\/(p|reel|tv)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(
			url.pathname,
		);
		if (!match || match[2] !== shortcode) return null;
		return {
			url: `https://www.instagram.com/${match[1]}/${shortcode}/`,
			kind: match[1] === "p" ? "post" : "video",
		};
	} catch {
		return null;
	}
}

/**
 * Accept only plain HTTPS asset URLs without query strings or fragments.
 * This DTO does not retain signed or credential-like URL parameters; if a
 * future observed provider URL needs them, that requires an explicit review.
 */
function canonicalAssetUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.hostname.length === 0
		) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

function importedAt(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 10_000_000_000;
}

/** Normalize one strictly validated Anansi DOM snapshot to a safe item. */
export function parseInstagramDomSnapshot(
	value: unknown,
	context: ParseContext,
): NormalizedItem | null {
	if (!isRecord(context) || !importedAt(context.importedAt) || !isRecord(value)) {
		return null;
	}
	if (!hasOnlyKeys(value, SNAPSHOT_KEYS)) return null;
	if (value.schemaVersion !== INSTAGRAM_DOM_SNAPSHOT_SCHEMA_VERSION) return null;
	if (
		typeof value.shortcode !== "string" ||
		value.shortcode.length > MAX_SHORTCODE_LENGTH ||
		!SHORTCODE.test(value.shortcode)
	) {
		return null;
	}
	const permalink = canonicalPermalink(value.permalink, value.shortcode);
	if (!permalink) return null;
	if (!isBoundedText(value.caption, MAX_CAPTION_LENGTH, true)) return null;
	if (!isRecord(value.author) || !hasOnlyKeys(value.author, AUTHOR_KEYS)) return null;
	if (
		typeof value.author.handle !== "string" ||
		!HANDLE.test(value.author.handle) ||
		(value.author.name !== undefined &&
			!isBoundedText(value.author.name, MAX_AUTHOR_NAME_LENGTH, true))
	) {
		return null;
	}
	const rawImages = dataArray(value.imageRefs, MAX_IMAGES);
	if (!rawImages) return null;
	const imageUrls: string[] = [];
	for (const image of rawImages) {
		const canonical = canonicalAssetUrl(image);
		if (!canonical) return null;
		if (!imageUrls.includes(canonical)) imageUrls.push(canonical);
	}
	const videoPoster = value.videoPoster === undefined
		? undefined
		: canonicalAssetUrl(value.videoPoster);
	if (value.videoPoster !== undefined && !videoPoster) return null;
	if (value.caption.trim().length === 0 && imageUrls.length === 0 && !videoPoster) {
		return null;
	}

	const media: MediaRef[] = imageUrls.map((originUrl) => ({
		kind: "image",
		originUrl,
	}));
	if (videoPoster && !imageUrls.includes(videoPoster)) {
		media.push({ kind: "video_poster", originUrl: videoPoster });
	}
	return {
		source: "instagram",
		externalId: value.shortcode,
		url: permalink.url,
		kind: permalink.kind,
		authorHandle: value.author.handle.toLowerCase(),
		...(typeof value.author.name === "string" && value.author.name.trim()
			? { authorName: value.author.name.trim() }
			: {}),
		body: value.caption.trim(),
		savedAt: context.importedAt,
		savedAtIsExact: false,
		metrics: {},
		media,
		links: [],
		// Never copy a page payload or arbitrary DOM fields into persisted raw data.
		raw: { snapshotSchemaVersion: INSTAGRAM_DOM_SNAPSHOT_SCHEMA_VERSION },
	};
}

/** Parse a batch from the same Anansi-owned DTO, dropping invalid snapshots. */
export function parseInstagramDomSnapshots(
	value: unknown,
	context: ParseContext,
): NormalizedItem[] {
	const snapshots = dataArray(value, MAX_IMAGES);
	if (!snapshots) return [];
	const items = new Map<string, NormalizedItem>();
	for (const snapshot of snapshots) {
		const item = parseInstagramDomSnapshot(snapshot, context);
		if (item && !items.has(item.externalId)) items.set(item.externalId, item);
	}
	return [...items.values()];
}
