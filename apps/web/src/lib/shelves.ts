import { useSyncExternalStore } from "react";
import { sourceLabel, type ItemQuery, type Shelf, type ShelfColor, type ShelfInput, type ShelfSuggestion } from "./api.ts";
import { libraryKeys } from "./library-query.ts";
import { topicColorIndex } from "./tag-colors.ts";

/**
 * Shelves, the parts that are not drawing.
 *
 * A shelf is a name, a colour, an icon and an optional rule (library filters),
 * plus saves added by hand and minus saves taken off by hand. Everything here
 * is pure or a tiny store, so the rail, the dialog, the picker and the palette
 * agree on what a rule says and how a list moves.
 */

export type ShelfRule = Shelf["filters"];

/** Under `libraryKeys.all`, so a bulk change that reloads the library reloads counts too. */
export const shelfKeys = {
	list: () => [...libraryKeys.all, "shelves"] as const,
	suggestions: () => [...libraryKeys.all, "shelf-suggestions"] as const,
};

/** The server takes at most this many ids per call. */
export const SHELF_BATCH = 500;

export function chunk<T>(list: readonly T[], size = SHELF_BATCH): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
	return out;
}

/* ------------------------------------------------------------- colour --- */

/** `--shelf-<key>` in styles/shelves.css, tuned per theme. No colour reads as muted ink. */
export function shelfColor(color: ShelfColor | null | undefined): string {
	return color ? `var(--shelf-${color})` : "var(--muted)";
}

/**
 * The topic palette's slots, said as shelf colours, so a shelf made from a
 * topic keeps the colour its dot already has.
 */
const TOPIC_SLOT_TO_SHELF: ShelfColor[] = ["green", "blue", "amber", "orange", "violet", "teal", "green", "pink", "sky", "violet"];

export function topicShelfColor(label: string): ShelfColor {
	return TOPIC_SLOT_TO_SHELF[topicColorIndex(label)] ?? "slate";
}

/** A starting icon for a shelf made from a topic; the owner can change it. */
const TOPIC_ICONS: Record<string, string> = {
	design: "palette",
	"web dev": "code",
	finance: "chart-line",
	lifestyle: "coffee",
	music: "music",
	"food & travel": "utensils",
	marketing: "megaphone",
	gaming: "gamepad-2",
	security: "shield",
	"entertainment & anime": "film",
	product: "package",
	health: "heart-pulse",
	career: "briefcase",
	learning: "graduation-cap",
	startups: "rocket",
	"hardware & networking": "cpu",
	devops: "server",
	science: "flask-conical",
	"ai / ml": "brain",
	news: "newspaper",
};

export function topicShelfIcon(label: string): string {
	return TOPIC_ICONS[label.trim().toLowerCase()] ?? "folder";
}

/** What "Create" sends for a topic suggestion. */
export function suggestionToShelf(suggestion: ShelfSuggestion): ShelfInput & { name: string } {
	return {
		name: suggestion.label,
		color: topicShelfColor(suggestion.label),
		icon: topicShelfIcon(suggestion.label),
		filters: { tag: [...suggestion.filters.tag] },
	};
}

/** Never more than one suggestion in the rail at a time. */
export function visibleSuggestion(suggestions: readonly ShelfSuggestion[] | undefined, dismissed: ReadonlySet<string> = new Set()): ShelfSuggestion | null {
	return suggestions?.find((suggestion) => !dismissed.has(suggestion.topic)) ?? null;
}

/* --------------------------------------------------------------- rule --- */

const MEDIA_WORDS: Record<string, string> = { any: "Has media", image: "Has images", video: "Has video", none: "No media" };
const TYPE_WORDS: Record<string, string> = { post: "Post", video: "Video", article: "Article", thread: "Thread reply", comment: "Comment", repo: "Repo" };

function either(values: string[]): string {
	if (values.length <= 1) return values[0] ?? "";
	return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/** Source names without the "bookmarks"/"stars" tail, which reads oddly mid-sentence. */
function sourceWord(source: string): string {
	return ({ x: "X", github: "GitHub", reddit: "Reddit", tiktok: "TikTok", web: "Web" } as Record<string, string>)[source] ?? sourceLabel(source);
}

/**
 * A rule in plain words, one clause per field: "Source is Reddit",
 * "Topic is Design or Science". `isTopic` decides whether a tag reads as a
 * topic or as one of the owner's tags.
 */
export function describeRule(rule: ShelfRule | null | undefined, isTopic: (label: string) => boolean = () => false): string[] {
	if (!rule) return [];
	const parts: string[] = [];
	if (rule.query?.trim()) parts.push(`Matches “${rule.query.trim()}”`);
	if (rule.source?.length) parts.push(`Source is ${either(rule.source.map(sourceWord))}`);
	if (rule.tag?.length) {
		const topics = rule.tag.filter(isTopic);
		const tags = rule.tag.filter((label) => !isTopic(label));
		if (topics.length) parts.push(`Topic is ${either(topics)}`);
		if (tags.length) parts.push(`Tag is ${either(tags)}`);
	}
	if (rule.author?.length) parts.push(`Author is ${either(rule.author.map((handle) => `@${handle}`))}`);
	if (rule.type?.length) parts.push(`Type is ${either(rule.type.map((type) => TYPE_WORDS[type] ?? type))}`);
	if (rule.media) parts.push(MEDIA_WORDS[rule.media] ?? `Media is ${rule.media}`);
	if (rule.favorite) parts.push("Favorites");
	if (rule.archived) parts.push("Archived");
	if (rule.removed === "exclude") parts.push("Still saved");
	if (rule.removed === "only") parts.push("Removed at source");
	return parts;
}

/** A rule that narrows nothing means the shelf is filled by hand. */
export function hasRule(rule: ShelfRule | null | undefined): boolean {
	return describeRule(rule).length > 0;
}

/**
 * The library's filters, kept only where they narrow: what a shelf stores as
 * its rule. Paging, ordering and the shelf itself are view state, not rule.
 */
export function ruleFromFilters(filters: Omit<ItemQuery, "removed"> & { removed?: string; query?: string }): ShelfRule {
	const rule: ShelfRule = {};
	const list = (values: string[] | undefined) => (values && values.length ? [...values] : undefined);
	const source = list(filters.source);
	const author = list(filters.author);
	const type = list(filters.type);
	const tag = list(filters.tag);
	if (source) rule.source = source;
	if (author) rule.author = author;
	if (type) rule.type = type;
	if (tag) rule.tag = tag;
	if (filters.media) rule.media = filters.media;
	if (filters.favorite) rule.favorite = true;
	if (filters.archived) rule.archived = true;
	if (filters.removed === "exclude" || filters.removed === "only") rule.removed = filters.removed;
	if (filters.query?.trim()) rule.query = filters.query.trim();
	return rule;
}

/* --------------------------------------------------------------- list --- */

/** Shelves in the order the rail shows them. */
export function sortShelves(shelves: readonly Shelf[]): Shelf[] {
	return [...shelves].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

/** Move one shelf to a new index; positions follow the new order. */
export function moveShelf(shelves: readonly Shelf[], id: string, to: number): Shelf[] {
	const list = sortShelves(shelves);
	const from = list.findIndex((shelf) => shelf.id === id);
	if (from < 0) return list;
	const target = Math.max(0, Math.min(list.length - 1, to));
	if (target === from) return list;
	const [moved] = list.splice(from, 1);
	list.splice(target, 0, moved!);
	return list.map((shelf, position) => ({ ...shelf, position }));
}

/**
 * Where a dragged row lands: the index whose slot holds the dragged row's
 * centre, given each row's resting top and height.
 */
export function dropIndex(rows: readonly { top: number; height: number }[], from: number, centre: number): number {
	let index = 0;
	for (let row = 0; row < rows.length; row++) {
		if (row === from) continue;
		const mid = rows[row]!.top + rows[row]!.height / 2;
		if (centre > mid) index++;
	}
	return index;
}

/* --------------------------------------------------------- membership --- */

/** The ids of the shelves a save is on, after one toggle. */
export function toggleMembership(current: readonly string[] | undefined, shelfId: string, on: boolean): string[] {
	const set = new Set(current ?? []);
	if (on) set.add(shelfId);
	else set.delete(shelfId);
	return [...set];
}

/** A shelf's count after `changed` saves went on (+) or came off (−). */
export function adjustCount(shelves: readonly Shelf[], shelfId: string, delta: number): Shelf[] {
	return shelves.map((shelf) => (shelf.id === shelfId ? { ...shelf, count: Math.max(0, shelf.count + delta) } : shelf));
}

/* ------------------------------------------------------- dialog store --- */

/**
 * One shelf dialog for the whole app.
 *
 * It opens from the rail, the library toolbar, ⌘K and the add-to-shelf
 * picker, which live in different trees; a small store means none of them
 * has to hold the others' state. The dialog itself is mounted once, by the
 * rail, which every page renders.
 */
export interface ShelfDialogRequest {
	/** Editing this shelf; absent to create one. */
	shelf?: Shelf;
	/** Create with this name already typed. */
	name?: string;
	/** Create with this rule already set. */
	rule?: ShelfRule;
	/** Saves to put on the new shelf once it exists. */
	itemIds?: string[];
	/** Called with the shelf after a successful save. */
	onSaved?: (shelf: Shelf) => void;
}

let request: ShelfDialogRequest | null = null;
const listeners = new Set<() => void>();

export function openShelfDialog(next: ShelfDialogRequest = {}): void {
	request = next;
	for (const listener of listeners) listener();
}

export function closeShelfDialog(): void {
	request = null;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useShelfDialogRequest(): ShelfDialogRequest | null {
	return useSyncExternalStore(subscribe, () => request, () => null);
}
