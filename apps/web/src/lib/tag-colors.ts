import { useSyncExternalStore } from "react";
import { api } from "./api.ts";

/**
 * Topic colour.
 *
 * AI topics get one small dot each, and the dot is the only colour a tag ever
 * carries. The hue is chosen here, not stored: a stable index into a calm
 * ten-step palette (`--topic-0` … `--topic-9` in styles/frame.css, tuned per
 * theme), so a topic is the same colour on a card, in the filter menu and in
 * the inspector. The owner's own tags stay neutral and have no dot.
 *
 * Tag summaries on cards carry a label and no id, and topic labels are unique
 * and canonical, so the label is the key.
 */
export const TOPIC_PALETTE_SIZE = 10;

/**
 * The v2 taxonomy has nineteen topics and the palette ten colours, so each
 * colour is shared by two topics chosen to rarely meet on one screen. A topic
 * the table does not know (a later taxonomy) falls back to a stable hash.
 */
const TOPIC_SLOTS: Record<string, number> = {
	finance: 0, lifestyle: 0,
	"web dev": 1, music: 1,
	design: 2, "food & travel": 2,
	marketing: 3, gaming: 3,
	security: 4, "entertainment & anime": 4,
	product: 5, health: 5,
	career: 6, learning: 6,
	startups: 7, "hardware & networking": 7,
	devops: 8, science: 8,
	"ai / ml": 9,
};

export function topicColorIndex(key: string): number {
	const text = key.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
	const slot = TOPIC_SLOTS[text];
	if (slot !== undefined) return slot;
	// FNV-1a: tiny, stable across sessions and runtimes.
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % TOPIC_PALETTE_SIZE;
}

export function topicColor(key: string): string {
	return `var(--topic-${topicColorIndex(key)})`;
}

/* --------------------------------------------------------- tag kinds --- */

/**
 * Which labels are AI topics.
 *
 * One small shared store rather than a query per chip: a grid shows hundreds
 * of chips, and the answer only changes when a new topic is first used. Before
 * it arrives every chip renders neutral, which is also the right fallback when
 * the request fails.
 */
type Kinds = ReadonlyMap<string, "topic" | "custom">;

const EMPTY: Kinds = new Map();
let kinds: Kinds = EMPTY;
let loading: Promise<void> | null = null;
let loadedAt = 0;
const listeners = new Set<() => void>();

function keyOf(label: string): string {
	return label.trim().toLowerCase();
}

export function setTagKinds(tags: { label: string; kind: "topic" | "custom" }[]): void {
	kinds = new Map(tags.map((tag) => [keyOf(tag.label), tag.kind]));
	loadedAt = Date.now();
	for (const listener of listeners) listener();
}

/** Ask again, at most once a minute; a tag edit can call it after saving. */
export function refreshTagKinds(force = false): void {
	if (loading || (!force && loadedAt && Date.now() - loadedAt < 60_000)) return;
	loading = api
		.tags()
		.then((result) => setTagKinds(result.tags))
		.catch(() => {})
		.finally(() => {
			loading = null;
		});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	refreshTagKinds();
	return () => listeners.delete(listener);
}

const snapshot = () => kinds;
const serverSnapshot = () => EMPTY;

export function useTagKinds(): Kinds {
	return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export function isTopic(kindsMap: Kinds, label: string): boolean {
	return kindsMap.get(keyOf(label)) === "topic";
}
