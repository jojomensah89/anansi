export const GITHUB_STARS_PAGE_SCHEMA_VERSION = 1 as const;

const MAX_REPOSITORIES_PER_PAGE = 100;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_LABEL_LENGTH = 100;
const MAX_URL_LENGTH = 2_000;
const MAX_COUNT = 1_000_000_000;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const RESERVED_OWNERS = new Set([
	"collections",
	"events",
	"explore",
	"features",
	"issues",
	"login",
	"logout",
	"marketplace",
	"new",
	"notifications",
	"organizations",
	"orgs",
	"pulls",
	"search",
	"settings",
	"signup",
	"sponsors",
	"stars",
	"topics",
	"users",
]);

export interface GitHubRepositoryLocation {
	identity: string;
	fullName: string;
	owner: string;
	name: string;
	url: string;
}

export interface GitHubStarredRepository extends GitHubRepositoryLocation {
	description?: string;
	language?: string;
	ownerAvatar?: string;
	visibility?: "public" | "private";
	stars?: number;
	forks?: number;
	starredAt?: string;
}

export interface GitHubStarsPage {
	schemaVersion: typeof GITHUB_STARS_PAGE_SCHEMA_VERSION;
	pageType: "github_stars";
	repositories: GitHubStarredRepository[];
	nextUrl?: string;
}

export type GitHubStarsExtraction =
	| { kind: "page"; page: GitHubStarsPage }
	| { kind: "empty"; page: GitHubStarsPage }
	| { kind: "signed_out" }
	| { kind: "page_shape_changed" };

export interface GitHubStarMutation {
	action: "save" | "unsave";
	externalId: string;
	canonicalUrl: string;
}

function boundedText(
	value: string | null | undefined,
	max: number,
): string | undefined {
	if (!value) return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.slice(0, max);
}

function githubUrl(value: string, baseUrl: string): URL | null {
	if (!value || value.length > MAX_URL_LENGTH) return null;
	try {
		const url = new URL(value, baseUrl);
		if (
			url.protocol !== "https:" ||
			url.hostname.toLowerCase() !== "github.com" ||
			url.username !== "" ||
			url.password !== ""
		) {
			return null;
		}
		return url;
	} catch {
		return null;
	}
}

export function githubRepositoryIdentity(
	owner: string,
	name: string,
): string | null {
	if (!OWNER.test(owner) || !REPOSITORY.test(name)) return null;
	if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
	return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function validatedGitHubRepositoryUrl(
	value: string,
	baseUrl: string,
): GitHubRepositoryLocation | null {
	const url = githubUrl(value, baseUrl);
	if (!url || url.search || url.hash) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 2) return null;
	const [owner, name] = parts;
	if (!owner || !name) return null;
	const identity = githubRepositoryIdentity(owner, name);
	if (!identity) return null;
	const fullName = `${owner}/${name}`;
	return {
		identity,
		fullName,
		owner,
		name,
		url: `https://github.com/${fullName}`,
	};
}

export function validatedGitHubStarsPageUrl(
	value: string,
	baseUrl: string,
): string | null {
	const url = githubUrl(value, baseUrl);
	if (!url || url.hash) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	const isOverview = parts.length === 1 && parts[0] === "stars";
	const isRepositoryList =
		parts.length === 3 &&
		parts[0] === "stars" &&
		parts[1] !== undefined &&
		OWNER.test(parts[1]) &&
		parts[2] === "repositories";
	if (!isOverview && !isRepositoryList) return null;
	if (url.searchParams.size > 3) return null;
	const seen = new Set<string>();
	for (const [key, parameter] of url.searchParams) {
		if (
			seen.has(key) ||
			!new Set([
				"after",
				"before",
				"page",
				...(isRepositoryList ? ["filter"] : []),
			]).has(key) ||
			parameter.length > 1_000
		) {
			return null;
		}
		seen.add(key);
	}
	if (isRepositoryList && url.searchParams.get("filter") !== "all") return null;
	return url.toString();
}

export function readGitHubStarMutation(
	value: string,
	method: string,
	ok: boolean,
): GitHubStarMutation | null {
	if (!ok || !new Set(["POST", "PUT", "DELETE"]).has(method.toUpperCase()))
		return null;
	const url = githubUrl(value, "https://github.com/");
	if (!url || url.search || url.hash) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 3) return null;
	const [owner, name, operation] = parts;
	if (!owner || !name || (operation !== "star" && operation !== "unstar"))
		return null;
	const repository = validatedGitHubRepositoryUrl(
		`/${owner}/${name}`,
		url.origin,
	);
	if (!repository) return null;
	return {
		action: operation === "star" ? "save" : "unsave",
		externalId: repository.identity,
		canonicalUrl: repository.url,
	};
}

function optionalHttpUrl(
	value: string | null,
	baseUrl: string,
): string | undefined {
	if (!value || value.length > MAX_URL_LENGTH) return undefined;
	try {
		const url = new URL(value, baseUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			(url.hostname !== "avatars.githubusercontent.com" &&
				url.hostname !== "github.com")
		) {
			return undefined;
		}
		return url.toString();
	} catch {
		return undefined;
	}
}

function compactCount(value: string | null | undefined): number | undefined {
	const text = value?.replace(/,/g, "").trim().toLowerCase();
	if (!text) return undefined;
	const match = text.match(/(\d+(?:\.\d+)?)\s*([kmb])?/);
	if (!match) return undefined;
	const numeric = Number(match[1]);
	const multiplier =
		match[2] === "k"
			? 1_000
			: match[2] === "m"
				? 1_000_000
				: match[2] === "b"
					? 1_000_000_000
					: 1;
	const result = Math.round(numeric * multiplier);
	return Number.isSafeInteger(result) && result >= 0 && result <= MAX_COUNT
		? result
		: undefined;
}

function linkCount(row: Element, suffix: string): number | undefined {
	const link = row.querySelector<HTMLAnchorElement>(`a[href$="/${suffix}"]`);
	return compactCount(link?.getAttribute("aria-label") ?? link?.textContent);
}

function isoDate(value: string | null): string | undefined {
	if (!value || value.length > 100 || !Number.isFinite(Date.parse(value)))
		return undefined;
	return value;
}

function extractRepository(
	row: Element,
	pageUrl: string,
): GitHubStarredRepository | null {
	const anchor = row.querySelector<HTMLAnchorElement>("h3 a[href], h2 a[href]");
	const location = validatedGitHubRepositoryUrl(
		anchor?.getAttribute("href") ?? "",
		pageUrl,
	);
	if (!location) return null;

	const description = boundedText(
		row.querySelector(
			'[itemprop="description"], :scope > .py-1 > p.col-9.color-fg-muted',
		)?.textContent,
		MAX_DESCRIPTION_LENGTH,
	);
	const language = boundedText(
		row.querySelector('[itemprop="programmingLanguage"]')?.textContent,
		MAX_LABEL_LENGTH,
	);
	const privateLabel = Array.from(row.querySelectorAll(".Label")).some(
		(label) =>
			boundedText(label.textContent, MAX_LABEL_LENGTH)?.toLowerCase() ===
			"private",
	);
	const ownerAvatar =
		optionalHttpUrl(
			row.querySelector<HTMLImageElement>("img.avatar")?.getAttribute("src") ??
				null,
			pageUrl,
		) ?? `https://github.com/${encodeURIComponent(location.owner)}.png?size=80`;
	const stars = linkCount(row, "stargazers");
	const forks = linkCount(row, "forks");
	const starredAt = isoDate(
		row
			.querySelector("[data-anansi-starred-at], relative-time[datetime]")
			?.getAttribute("datetime") ?? null,
	);

	return {
		...location,
		...(description ? { description } : {}),
		...(language ? { language } : {}),
		...(ownerAvatar ? { ownerAvatar } : {}),
		visibility: privateLabel ? "private" : "public",
		...(stars !== undefined ? { stars } : {}),
		...(forks !== undefined ? { forks } : {}),
		...(starredAt ? { starredAt } : {}),
	};
}

function emptyPage(): GitHubStarsPage {
	return {
		schemaVersion: GITHUB_STARS_PAGE_SCHEMA_VERSION,
		pageType: "github_stars",
		repositories: [],
	};
}

export function extractGitHubStarsPage(
	document: Document,
	pageUrl: string,
): GitHubStarsExtraction {
	if (!validatedGitHubStarsPageUrl(pageUrl, pageUrl))
		return { kind: "page_shape_changed" };
	if (
		document.documentElement.classList.contains("logged-out") ||
		document.querySelector('form[action="/session"]')
	) {
		return { kind: "signed_out" };
	}

	const rows = Array.from(
		document.querySelectorAll(
			"[data-anansi-starred-repository], [data-testid=starred-repository], li.tmp-py-4.border-bottom, li.py-4.border-bottom, div.py-4.border-bottom",
		),
	).slice(0, MAX_REPOSITORIES_PER_PAGE);
	if (rows.length === 0) {
		return document.querySelector(".blankslate, [data-testid=empty-state]")
			? { kind: "empty", page: emptyPage() }
			: { kind: "page_shape_changed" };
	}

	const repositories = rows
		.map((row) => extractRepository(row, pageUrl))
		.filter(
			(repository): repository is GitHubStarredRepository =>
				repository !== null,
		);
	if (repositories.length === 0) return { kind: "page_shape_changed" };

	const currentPath = new URL(pageUrl).pathname.replace(/\/+$/, "");
	const allRepositoriesHref =
		currentPath === "/stars"
			? Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
					.find((anchor) => {
						const candidate = validatedGitHubStarsPageUrl(
							anchor.getAttribute("href") ?? "",
							pageUrl,
						);
						if (!candidate) return false;
						const url = new URL(candidate);
						return (
							url.pathname.endsWith("/repositories") &&
							url.searchParams.get("filter") === "all"
						);
					})
					?.getAttribute("href")
			: undefined;
	const nextHref =
		allRepositoriesHref ??
		document
			.querySelector<HTMLAnchorElement>('a[rel="next"]')
			?.getAttribute("href");
	const nextUrl = nextHref
		? validatedGitHubStarsPageUrl(nextHref, pageUrl)
		: null;
	return {
		kind: "page",
		page: {
			schemaVersion: GITHUB_STARS_PAGE_SCHEMA_VERSION,
			pageType: "github_stars",
			repositories,
			...(nextUrl ? { nextUrl } : {}),
		},
	};
}
