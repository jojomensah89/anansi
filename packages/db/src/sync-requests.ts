import { and, desc, eq, sql } from "drizzle-orm";
import { items, syncRequests, platformSync, syncSettings } from "./schema.ts";
import { disabledSources } from "./queries.ts";
import type { AnansiDb } from "./types.ts";

/** Asks the extension to check platforms at its next check-in. */
export async function requestLibrarySync(
	db: AnansiDb,
	requestedAt: number,
): Promise<void> {
	await db
		.insert(syncRequests)
		.values({ id: 1, requestedAt })
		.onConflictDoUpdate({
			target: syncRequests.id,
			set: { requestedAt },
		});
}

export async function latestLibrarySyncRequest(
	db: AnansiDb,
): Promise<number | null> {
	const [row] = await db
		.select()
		.from(syncRequests)
		.where(eq(syncRequests.id, 1));
	return row?.requestedAt ?? null;
}

/** A bounded pre-run snapshot. Removed saves must never terminate catch-up. */
export async function knownSyncIds(
	db: AnansiDb,
	source: string,
): Promise<string[]> {
	const rows = await db
		.select({ id: items.externalId })
		.from(items)
		.where(and(eq(items.source, source), eq(items.platformSaved, 1)))
		.orderBy(desc(items.savedAt), desc(items.id))
		.limit(2000);
	return rows.map((row) => row.id);
}

export const SYNC_PLATFORMS = ["x", "reddit", "github", "tiktok"] as const;
export async function getSyncSettings(db: AnansiDb) {
	const [row] = await db
		.select()
		.from(syncSettings)
		.where(eq(syncSettings.id, 1));
	return {
		agentTabs: row?.agentTabs === 1,
		githubUsername: row?.githubUsername ?? null,
		githubCheckedAt: row?.githubCheckedAt ?? null,
		githubError: row?.githubError ?? null,
		githubRetryAt: row?.githubRetryAt ?? 0,
	};
}
export async function setSyncSettings(
	db: AnansiDb,
	value: { agentTabs: boolean; githubUsername: string | null },
) {
	if (
		value.githubUsername !== null &&
		!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(
			value.githubUsername,
		)
	)
		throw new Error("invalid GitHub username");
	const row = {
		id: 1,
		agentTabs: Number(value.agentTabs),
		githubUsername: value.githubUsername,
	};
	await db
		.insert(syncSettings)
		.values(row)
		.onConflictDoUpdate({ target: syncSettings.id, set: row });
}
export async function pendingPlatformSync(db: AnansiDb) {
	const settings = await getSyncSettings(db);
	const rows = await db.select().from(platformSync);
	return rows.filter(
		(row) =>
			settings.agentTabs ||
			row.trigger !== "agent" ||
			row.source === "reddit" ||
			row.source === "github",
	);
}
/** Agent throttling is atomic per platform, independent of library requests. */
export async function requestPlatformSync(
	db: AnansiDb,
	at: number,
	kind: "library" | "force" | "agent",
) {
	const settings = await getSyncSettings(db);
	const disabled = await disabledSources(db);
	const selected = SYNC_PLATFORMS.filter(
		(source) =>
			!disabled.includes(source) &&
			(kind !== "agent" ||
				settings.agentTabs ||
				source === "reddit" ||
				source === "github"),
	);
	const requested: string[] = [];
	for (const source of selected) {
		const rows = await db
			.insert(platformSync)
			.values({
				source,
				requestedAt: at,
				forced: Number(kind === "force"),
				trigger: kind,
				agentAt: kind === "agent" ? at : 0,
			})
			.onConflictDoUpdate({
				target: platformSync.source,
				set: {
					requestedAt: at,
					forced: Number(kind === "force"),
					trigger: kind,
					...(kind === "agent" ? { agentAt: at } : {}),
				},
				...(kind === "agent"
					? { setWhere: sql`${platformSync.agentAt} <= ${at - 900}` }
					: {}),
			})
			.returning();
		if (rows.length) requested.push(source);
	}
	return requested;
}

export async function recordPublicGithubCheck(
	db: AnansiDb,
	at: number,
	error: string | null,
	retryAt: number,
) {
	await db
		.insert(syncSettings)
		.values({
			id: 1,
			githubCheckedAt: at,
			githubError: error,
			githubRetryAt: retryAt,
		})
		.onConflictDoUpdate({
			target: syncSettings.id,
			set: { githubCheckedAt: at, githubError: error, githubRetryAt: retryAt },
		});
}

/** Atomically lease public checks across overlapping library visits. */
export async function claimPublicGithubCheck(
	db: AnansiDb,
	at: number,
	force: boolean,
): Promise<boolean> {
	const rows = await db
		.update(syncSettings)
		.set({ githubCheckedAt: at, githubError: null, githubRetryAt: at + 300 })
		.where(
			and(
				eq(syncSettings.id, 1),
				sql`(${syncSettings.githubRetryAt} <= ${at} OR (${Number(force)} = 1 AND ${syncSettings.githubError} IS NULL))`,
			),
		)
		.returning({ id: syncSettings.id });
	return rows.length > 0;
}
