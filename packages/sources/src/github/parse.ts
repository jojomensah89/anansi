import type { ParseContext } from "../context.ts";
import type { NormalizedItem } from "../item.ts";

type Any = Record<string, any>;

/** README bodies are for retrieval, not archival — the head is enough. */
export const README_CHARS = 2000;

export interface StarredRawPage {
	/** Exactly as GitHub returned it. */
	starred: unknown[];
	/** Fetched separately, keyed by full_name, so `starred` stays untouched. */
	readmes?: Record<string, string>;
}

interface ExtensionStarsPage {
	schemaVersion: 1;
	pageType: "github_stars";
	repositories: unknown[];
	nextUrl?: string;
}

interface RepositoryLocation {
	identity: string;
	fullName: string;
	owner: string;
	name: string;
	url: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

function unix(iso: unknown): number | undefined {
	if (typeof iso !== "string") return undefined;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const normalized = value.trim();
		const url = new URL(normalized);
		return (url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password
			? normalized
			: undefined;
	} catch {
		return undefined;
	}
}

function location(
	fullNameValue: unknown,
	urlValue: unknown,
): RepositoryLocation | null {
	const fullName = nonEmpty(fullNameValue);
	if (!fullName) return null;
	const parts = fullName.split("/");
	if (parts.length !== 2) return null;
	const [owner, name] = parts;
	if (!owner || !name || !OWNER.test(owner) || !REPOSITORY.test(name))
		return null;

	if (urlValue !== undefined) {
		const supplied = httpUrl(urlValue);
		if (!supplied) return null;
		const url = new URL(supplied);
		const suppliedParts = url.pathname.split("/").filter(Boolean);
		if (
			url.protocol !== "https:" ||
			url.hostname.toLowerCase() !== "github.com" ||
			url.search ||
			url.hash ||
			suppliedParts.length !== 2 ||
			suppliedParts[0]?.toLowerCase() !== owner.toLowerCase() ||
			suppliedParts[1]?.toLowerCase() !== name.toLowerCase()
		) {
			return null;
		}
	}

	return {
		identity: `${owner.toLowerCase()}/${name.toLowerCase()}`,
		fullName,
		owner,
		name,
		url: `https://github.com/${fullName}`,
	};
}

function metric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function visibility(
	value: unknown,
	isPrivate: unknown,
): "public" | "private" | undefined {
	if (value === "public" || value === "private") return value;
	if (typeof isPrivate === "boolean") return isPrivate ? "private" : "public";
	return undefined;
}

function extensionPage(value: unknown): value is ExtensionStarsPage {
	const page = value as Partial<ExtensionStarsPage> | null;
	return (
		page?.schemaVersion === 1 &&
		page.pageType === "github_stars" &&
		Array.isArray(page.repositories)
	);
}

/** Normalize API and extension captures to one stable owner/repository identity. */
export function parseStarredPage(
	raw: unknown,
	ctx: ParseContext,
): NormalizedItem[] {
	const page = raw as StarredRawPage | Any[] | null;
	const fromExtension = extensionPage(raw);
	const entries = (
		fromExtension
			? raw.repositories
			: Array.isArray(page)
				? page
				: Array.isArray(page?.starred)
					? page.starred
					: []
	) as Any[];
	const readmes: Record<string, string> =
		fromExtension || Array.isArray(page) || !page?.readmes || Array.isArray(page.readmes)
			? {}
			: page.readmes;
	const items: NormalizedItem[] = [];

	for (const entry of entries) {
		const repo: Any | undefined = fromExtension
			? entry
			: (entry?.repo ?? entry);
		if (!repo || typeof repo !== "object") continue;
		const repository = location(
			fromExtension ? repo.fullName : repo.full_name,
			fromExtension ? repo.url : repo.html_url,
		);
		if (!repository) continue;

		if (
			fromExtension &&
			(typeof repo.identity !== "string" ||
				repo.identity.toLowerCase() !== repository.identity)
		) {
			continue;
		}

		const description = nonEmpty(repo.description) ?? "";
		const readme = readmes[repository.fullName]?.slice(0, README_CHARS);
		const starredAtValue = fromExtension ? repo.starredAt : entry?.starred_at;
		const starredAt = unix(starredAtValue);
		const owner = fromExtension
			? nonEmpty(repo.owner)
			: nonEmpty(repo.owner?.login);
		const ownerAvatar = httpUrl(
			fromExtension ? repo.ownerAvatar : repo.owner?.avatar_url,
		);
		const language = nonEmpty(repo.language);
		const repositoryVisibility = visibility(repo.visibility, repo.private);
		const stars = metric(fromExtension ? repo.stars : repo.stargazers_count);
		const forks = metric(fromExtension ? repo.forks : repo.forks_count);
		const openIssues = metric(repo.open_issues_count);
		const watchers = metric(repo.subscribers_count ?? repo.watchers_count);
		const metrics = Object.fromEntries(
			Object.entries({ stars, forks, openIssues, watchers }).filter(
				(entry): entry is [string, number] => entry[1] !== undefined,
			),
		);
		const homepage = fromExtension ? undefined : httpUrl(repo.homepage);

		items.push({
			source: "github",
			externalId: repository.identity,
			url: repository.url,
			kind: "repo",
			...(owner ? { authorHandle: owner, authorName: owner } : {}),
			...(ownerAvatar ? { authorAvatar: ownerAvatar } : {}),
			title: repository.fullName,
			body: [description, readme].filter(Boolean).join("\n\n").trim(),
			postedAt: fromExtension
				? unix(repo.pushedAt ?? repo.updatedAt ?? repo.createdAt)
				: (unix(repo.pushed_at) ?? unix(repo.created_at)),
			savedAt: starredAt ?? ctx.importedAt,
			savedAtIsExact: starredAt !== undefined,
			...(starredAt !== undefined ? { saveOrder: starredAt } : {}),
			metrics,
			media: [],
			links: [homepage, repository.url].filter(
				(value): value is string => value !== undefined,
			),
			raw: {
				...(language ? { language } : {}),
				...(repositoryVisibility ? { visibility: repositoryVisibility } : {}),
				...(fromExtension
					? {}
					: {
							topics: Array.isArray(repo.topics) ? repo.topics : [],
							archived: repo.archived === true,
							repo,
						}),
				starredAt: typeof starredAtValue === "string" ? starredAtValue : null,
				hasReadme: readme !== undefined,
			},
		});
	}

	return items;
}
