import { and, eq, sql } from "drizzle-orm";
import { atomicWrite } from "./atomic.ts";
import { mutationChanges } from "./ai-jobs.ts";
import { aiEnrichmentJobs, aiTopics, itemTags, tags } from "./schema.ts";
import { TOPIC_DEFINITIONS, canonicalTopicId } from "./topics.ts";
import type { AnansiDb } from "./types.ts";
import { visibleSourceClause } from "./visibility.ts";

/**
 * The owner's topic list: the built-in topics, each of which can be switched
 * off or given a different description, plus topics the owner adds.
 *
 * Built-ins keep their ids. A custom topic's id always starts `custom-`,
 * which no built-in id does, and its tag is `topic:<id>` with kind 'topic',
 * the same shape as a built-in's, so the library treats both alike.
 */

/** Clef answers at most 64 questions a call; 40 still leaves one save per call. */
export const TOPIC_LIMIT = 40;
export const TOPIC_LABEL_MAX = 32;
export const TOPIC_DESCRIPTION_MAX = 160;
const CUSTOM_PREFIX = "custom-";

/** Accents for custom topics; chosen once from the id so they stay put. */
const CUSTOM_TOPIC_COLORS = ["#0891b2", "#7c3aed", "#db2777", "#059669", "#d97706", "#2563eb", "#dc2626", "#65a30d", "#9333ea", "#0d9488"];

export interface Topic {
	id: string;
	label: string;
	/** What Clef is told belongs here. */
	description: string;
	color: string;
	tagId: string;
	builtIn: boolean;
	enabled: boolean;
	/** The shipped description, for a built-in; lets the owner reset an edit. */
	defaultDescription?: string;
}

export class TopicSettingsError extends Error {
	readonly status: 400 | 404 | 409;
	constructor(status: 400 | 404 | 409, message: string) {
		super(message);
		this.name = "TopicSettingsError";
		this.status = status;
	}
}

const now = () => Math.floor(Date.now() / 1000);

function cleanText(value: string): string {
	return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Every topic, built-ins first in their shipped order, then custom ones by age. */
export async function listTopics(db: AnansiDb): Promise<Topic[]> {
	const rows = await db.select().from(aiTopics).orderBy(aiTopics.createdAt, aiTopics.id);
	const overrides = new Map(rows.filter((row) => row.builtIn === 1).map((row) => [row.id, row]));
	const builtIns = TOPIC_DEFINITIONS.map((topic): Topic => {
		const row = overrides.get(topic.id);
		return {
			id: topic.id,
			label: topic.label,
			description: row?.description ?? topic.description,
			defaultDescription: topic.description,
			color: topic.color,
			tagId: `topic:${topic.id}`,
			builtIn: true,
			enabled: row ? row.enabled === 1 : true,
		};
	});
	const custom = rows.filter((row) => row.builtIn !== 1 && row.id.startsWith(CUSTOM_PREFIX) && row.label).map((row): Topic => ({
		id: row.id,
		label: row.label!,
		description: row.description ?? "",
		color: row.color ?? CUSTOM_TOPIC_COLORS[0]!,
		tagId: `topic:${row.id}`,
		builtIn: false,
		enabled: row.enabled === 1,
	}));
	return [...builtIns, ...custom];
}

/** The topics Clef is asked about. */
export async function activeTopics(db: AnansiDb): Promise<Topic[]> {
	return (await listTopics(db)).filter((topic) => topic.enabled);
}

/** Every topic with how many visible saves carry its tag, in two queries. */
export async function topicSettings(db: AnansiDb): Promise<Array<Topic & { count: number }>> {
	const [topics, counts] = await Promise.all([
		listTopics(db),
		db.all<{ tagId: string; n: number }>(sql`
			select it.tag_id as tagId, count(*) as n
			from item_tags it join items i on i.id = it.item_id
			where substr(it.tag_id, 1, 6) = 'topic:' and ${visibleSourceClause(sql`i.source`)}
			group by it.tag_id`),
	]);
	const byTag = new Map(counts.map((row) => [row.tagId, Number(row.n)]));
	return topics.map((topic) => ({ ...topic, count: byTag.get(topic.tagId) ?? 0 }));
}

function slug(label: string): string {
	return label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function colorFor(id: string): string {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return CUSTOM_TOPIC_COLORS[hash % CUSTOM_TOPIC_COLORS.length]!;
}

function validDescription(value: unknown): string {
	if (typeof value !== "string") throw new TopicSettingsError(400, "Description must be text");
	const description = cleanText(value);
	if (description.length > TOPIC_DESCRIPTION_MAX) throw new TopicSettingsError(400, `Description can be at most ${TOPIC_DESCRIPTION_MAX} characters`);
	return description;
}

function assertRoom(topics: readonly Topic[], adding: number): void {
	if (topics.filter((topic) => topic.enabled).length + adding > TOPIC_LIMIT) {
		throw new TopicSettingsError(409, `At most ${TOPIC_LIMIT} topics can be on at once`);
	}
}

/** Add an owner topic. Its tag is created now, so it can be used before any tagging runs. */
export async function createTopic(db: AnansiDb, input: { label: unknown; description?: unknown }): Promise<Topic> {
	if (typeof input.label !== "string") throw new TopicSettingsError(400, "Topic name is required");
	const label = cleanText(input.label);
	if (!label || label.length > TOPIC_LABEL_MAX) throw new TopicSettingsError(400, `Topic name must be 1–${TOPIC_LABEL_MAX} characters`);
	const description = input.description === undefined ? "" : validDescription(input.description);
	const topics = await listTopics(db);
	assertRoom(topics, 1);
	const lower = label.toLowerCase();
	if (canonicalTopicId(label) || topics.some((topic) => topic.label.toLowerCase() === lower)) {
		throw new TopicSettingsError(409, `“${label}” is already a topic`);
	}
	const [taken] = await db.select({ id: tags.id }).from(tags).where(sql`lower(${tags.label}) = ${lower}`).limit(1);
	if (taken) throw new TopicSettingsError(409, `A tag named “${label}” already exists`);

	const base = `${CUSTOM_PREFIX}${slug(label) || crypto.randomUUID().slice(0, 8)}`;
	const ids = new Set(topics.map((topic) => topic.id));
	const existingRows = new Set((await db.select({ id: aiTopics.id }).from(aiTopics)).map((row) => row.id));
	let id = base;
	for (let n = 2; ids.has(id) || existingRows.has(id); n++) id = `${base}-${n}`;
	const color = colorFor(id);
	const at = now();
	await atomicWrite(db, (tx) => [
		tx.insert(aiTopics).values({ id, builtIn: 0, label, description, color, enabled: 1, createdAt: at, updatedAt: at }),
		tx.insert(tags).values({ id: `topic:${id}`, label, color, origin: "ai", kind: "topic" }).onConflictDoUpdate({ target: tags.id, set: { label, color, origin: "ai", kind: "topic" } }),
	]);
	return { id, label, description, color, tagId: `topic:${id}`, builtIn: false, enabled: true };
}

/**
 * Switch a topic on or off, or change what Clef is told about it. A built-in's
 * description goes back to the shipped one when set to null.
 *
 * Switching off keeps every tag already given; tagging only stops adding it.
 */
export async function updateTopic(db: AnansiDb, id: string, changes: { enabled?: unknown; description?: unknown }): Promise<Topic> {
	if (changes.enabled !== undefined && typeof changes.enabled !== "boolean") throw new TopicSettingsError(400, "enabled must be true or false");
	const topics = await listTopics(db);
	const topic = topics.find((entry) => entry.id === id);
	if (!topic) throw new TopicSettingsError(404, "No such topic");
	if (changes.enabled === true && !topic.enabled) assertRoom(topics, 1);
	let description: string | null | undefined;
	if (changes.description === null) {
		if (!topic.builtIn) throw new TopicSettingsError(400, "Description must be text");
		description = null;
	} else if (changes.description !== undefined) {
		description = validDescription(changes.description);
		if (topic.builtIn && description === topic.defaultDescription) description = null;
	}
	const enabled = changes.enabled === undefined ? topic.enabled : changes.enabled;
	const at = now();
	if (topic.builtIn) {
		const [row] = await db.select().from(aiTopics).where(eq(aiTopics.id, id));
		const nextDescription = description === undefined ? row?.description ?? null : description;
		await db.insert(aiTopics).values({ id, builtIn: 1, label: null, description: nextDescription, color: null, enabled: enabled ? 1 : 0, createdAt: at, updatedAt: at })
			.onConflictDoUpdate({ target: aiTopics.id, set: { description: nextDescription, enabled: enabled ? 1 : 0, updatedAt: at } });
	} else {
		await db.update(aiTopics).set({ ...(description === undefined ? {} : { description: description ?? "" }), enabled: enabled ? 1 : 0, updatedAt: at }).where(eq(aiTopics.id, id));
	}
	const next = (await listTopics(db)).find((entry) => entry.id === id);
	if (!next) throw new TopicSettingsError(404, "No such topic");
	return next;
}

/**
 * Remove an owner topic. Its AI-given tags go with it. Where the owner also
 * put the tag on saves by hand, the tag stays on those as an ordinary tag.
 */
export async function deleteTopic(db: AnansiDb, id: string): Promise<void> {
	const topic = (await listTopics(db)).find((entry) => entry.id === id);
	if (!topic) throw new TopicSettingsError(404, "No such topic");
	if (topic.builtIn) throw new TopicSettingsError(400, "Built-in topics can be turned off, not deleted");
	const tagId = topic.tagId;
	const anyAssignment = sql`exists (select 1 from item_tags where item_tags.tag_id = ${tagId})`;
	await atomicWrite(db, (tx) => [
		tx.delete(itemTags).where(and(eq(itemTags.tagId, tagId), eq(itemTags.provenance, "ai"))),
		tx.update(tags).set({ kind: "custom", origin: "manual" }).where(and(eq(tags.id, tagId), anyAssignment)),
		tx.delete(tags).where(and(eq(tags.id, tagId), sql`not ${anyAssignment}`)),
		tx.delete(aiTopics).where(eq(aiTopics.id, id)),
	]);
}

/**
 * Ask Clef about every save again with the current list, the way the v2
 * list did. Existing topics stay on each save until its new answer replaces
 * them. Returns how many tagging jobs were reopened.
 */
export async function requeueTagging(db: AnansiDb): Promise<number> {
	const result = await db.update(aiEnrichmentJobs)
		.set({ status: "pending", attempts: 0, nextRunAt: 0, leaseUntil: 0, claimToken: null, lastError: null, updatedAt: now() })
		.where(eq(aiEnrichmentJobs.kind, "tagging"))
		.run();
	return mutationChanges(result);
}

/**
 * Map model output onto the given topics: an id, a name, or (for built-ins)
 * one of their approved aliases. Anything else is dropped.
 */
export function resolveTopicIds(values: unknown, topics: readonly Pick<Topic, "id" | "label">[], max = 3): string[] {
	if (!Array.isArray(values)) return [];
	const bound = Math.min(Math.max(Math.trunc(max), 1), 3);
	const byKey = new Map<string, string>();
	for (const topic of topics) {
		byKey.set(topic.id.toLowerCase(), topic.id);
		byKey.set(cleanText(topic.label).toLowerCase(), topic.id);
	}
	const known = new Set(topics.map((topic) => topic.id));
	const result: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const alias = canonicalTopicId(value);
		const id = byKey.get(cleanText(value).toLowerCase()) ?? (alias && known.has(alias) ? alias : undefined);
		if (id && !result.includes(id)) result.push(id);
		if (result.length >= bound) break;
	}
	return result;
}
