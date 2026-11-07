import {
	claimPublicGithubCheck,
	disabledSources,
	getSyncSettings,
	knownSyncIds,
	recordPublicGithubCheck,
	applyCapture,
	type AnansiDb,
} from "@anansi/db";
import { parseStarredPage } from "@anansi/sources";

/** Public stars only. No session, auth header, caller URL or redirect. */
export async function checkPublicGithub(
	db: AnansiDb,
	fetcher: typeof fetch = fetch,
	now = Math.floor(Date.now() / 1000),
	force = false,
) {
	const settings = await getSyncSettings(db);
	if (
		!settings.githubUsername ||
		(settings.githubRetryAt > now &&
			(!force || settings.githubError !== null)) ||
		(await disabledSources(db)).includes("github")
	)
		return;
	// Record a lease before I/O; repeated library visits share the five-minute window.
	if (!(await claimPublicGithubCheck(db, now, force))) return;
	try {
		const known = new Set(await knownSyncIds(db, "github"));
		for (let page = 1; page <= 10; page++) {
			const response = await fetcher(
				`https://api.github.com/users/${encodeURIComponent(settings.githubUsername)}/starred?sort=created&direction=desc&per_page=100&page=${page}`,
				{
					headers: {
						Accept: "application/vnd.github.star+json",
						"User-Agent": "Anansi",
					},
					credentials: "omit",
					redirect: "error",
					signal: AbortSignal.timeout(15000),
				},
			);
			if (response.status === 403 || response.status === 429) {
				const reset = Number(response.headers.get("x-ratelimit-reset"));
				await recordPublicGithubCheck(
					db,
					now,
					"rate_limited",
					Math.min(
						now + 86400,
						Math.max(now + 300, Number.isFinite(reset) ? reset : now + 3600),
					),
				);
				return;
			}
			if (!response.ok) throw new Error("public_github_failed");
			const raw = await response.json();
			if (!Array.isArray(raw) || raw.length > 100)
				throw new Error("public_github_shape_changed");
			const parsed = parseStarredPage(raw, { importedAt: now });
			if (raw.length && parsed.length !== raw.length)
				throw new Error("public_github_shape_changed");
			const found = parsed.some((item) => known.has(item.externalId));
			if (parsed.length)
				await applyCapture(
					db,
					{
						schemaVersion: 1,
						payloadType: "raw_page",
						action: "snapshot",
						source: "github",
						captureMethod: "platform_event",
						eventId: crypto.randomUUID(),
						runId: `public-github:${now}`,
						page,
						observedAt: now,
						raw,
					},
					parsed,
				);
			if (found || raw.length < 100) {
				await recordPublicGithubCheck(db, now, null, now + 300);
				return;
			}
		}
		await recordPublicGithubCheck(db, now, "page_limit", now + 300);
	} catch {
		await recordPublicGithubCheck(db, now, "public_github_failed", now + 300);
	}
}
