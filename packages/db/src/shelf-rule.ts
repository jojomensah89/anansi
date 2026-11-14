export interface ShelfRule { source?: string[]; author?: string[]; tag?: string[]; contentType?: string[]; media?: string; favorite?: boolean; nsfw?: boolean; archived?: boolean; removed?: "exclude" | "only"; query?: string; since?: number; until?: number; }
function textList(value: unknown): string[] {
	const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return [...new Set(list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 200))];
}

/**
 * Read stored filters as a rule. Both the library URL's `type` and the query
 * layer's `contentType` are accepted. Returns null when nothing in them
 * narrows the library, which makes the shelf hand-filled only.
 */
export function parseShelfRule(filters: unknown): ShelfRule | null {
	if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;
	const raw = filters as Record<string, unknown>;
	const rule: ShelfRule = {};
	const source = textList(raw.source);
	const author = textList(raw.author);
	const tag = textList(raw.tag);
	const contentType = textList(raw.contentType ?? raw.type);
	if (source.length) rule.source = source;
	if (author.length) rule.author = author;
	if (tag.length) rule.tag = tag;
	if (contentType.length) rule.contentType = contentType;
	if (typeof raw.media === "string" && ["any", "image", "video", "none"].includes(raw.media)) rule.media = raw.media;
	// The library reads these two only when they are switched on.
	if (raw.favorite === true) rule.favorite = true;
	if (raw.nsfw === true) rule.nsfw = true;
	if (raw.archived === true) rule.archived = true;
	if (raw.removed === "exclude" || raw.removed === "only") rule.removed = raw.removed;
	if (typeof raw.query === "string" && raw.query.trim()) rule.query = raw.query.trim().slice(0, 500);
	if (typeof raw.since === "number" && Number.isFinite(raw.since)) rule.since = raw.since;
	if (typeof raw.until === "number" && Number.isFinite(raw.until)) rule.until = raw.until;
	const narrows = Boolean(rule.source || rule.author || rule.tag || rule.contentType || rule.media || rule.favorite || rule.archived
		|| rule.nsfw || rule.removed === "exclude" || rule.removed === "only" || rule.query || rule.since !== undefined || rule.until !== undefined);
	return narrows ? rule : null;
}

const MEDIA_WORDS: Record<string, string> = { any: "Has media", image: "Has images", video: "Has video", none: "No media" };
const TYPE_WORDS: Record<string, string> = { post: "Post", video: "Video", article: "Article", thread: "Thread reply", comment: "Comment", repo: "Repo" };

function either(values: string[]): string {
	if (values.length <= 1) return values[0] ?? "";
	return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/** Source names without the "bookmarks"/"stars" tail, which reads oddly mid-sentence. */
function sourceWord(source: string): string {
	return ({ x: "X", github: "GitHub", reddit: "Reddit", tiktok: "TikTok", web: "Web" } as Record<string, string>)[source] ?? source;
}

/**
 * A rule in plain words, one clause per field: "Source is Reddit",
 * "Topic is Design or Science". `isTopic` decides whether a tag reads as a
 * topic or as one of the owner's tags.
 */
export function describeRule(rule: unknown, isTopic: (label: string) => boolean = () => false): string[] {
	const parsed = parseShelfRule(rule);
	if (!parsed) return [];
	return describeParsedRule(parsed, isTopic);
}
function describeParsedRule(rule: ShelfRule, isTopic: (label: string) => boolean): string[] {
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
	if (rule.contentType?.length) parts.push(`Type is ${either(rule.contentType.map((type) => TYPE_WORDS[type] ?? type))}`);
	if (rule.media) parts.push(MEDIA_WORDS[rule.media] ?? `Media is ${rule.media}`);
	if (rule.favorite) parts.push("Favorites");
	if (rule.archived) parts.push("Archived");
	if (rule.removed === "exclude") parts.push("Still saved");
	if (rule.removed === "only") parts.push("Removed at source");
	if (rule.nsfw) parts.push("Includes sensitive content");
	if (rule.since !== undefined) parts.push(`Saved since ${rule.since}`);
	if (rule.until !== undefined) parts.push(`Saved before ${rule.until}`);
	return parts;
}


export function hasRule(rule: unknown): boolean { return parseShelfRule(rule) !== null; }
