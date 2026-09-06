/**
 * What the extension knows about TikTok, kept away from the page.
 *
 * TikTok is the source with the least room to manoeuvre. It publishes no
 * favourites API and signs its own web requests — X-Bogus and msToken are
 * computed by its bundle — so nothing outside the app can forge one. The whole
 * strategy is to watch what the app fetches for itself, which means the two
 * jobs here are telling its responses apart and knowing where to send the tab.
 *
 * Two distinctions matter and neither is cosmetic:
 *
 *   /api/user/collect/item_list  is Favourites — what you saved.
 *   /api/favorite/item_list      is Likes — a different action entirely.
 *
 * Treating the second as a bookmark fills the library with things you tapped a
 * heart on, which is not what anyone asked to keep.
 *
 * Nothing here signs, forges or stores a signature. What cannot be verified
 * from a real authenticated payload is driven by server configuration instead
 * of guessed at, so a wrong guess is a config change and never a reinstall.
 */

export interface EndpointConfig {
	/** Path fragments that carry Favourites, from the server config. */
	watchUrls?: string[];
}

/** Likes, and the other listings that are not saves. Never bookmarks. */
const NOT_FAVOURITES = [
	"/api/favorite/item_list",
	"/api/user/favorite/item_list",
	"/api/post/item_list",
	"/api/related/item_list",
];

function pathOf(url: string): string | null {
	try {
		return new URL(url, "https://www.tiktok.com").pathname;
	} catch {
		return null;
	}
}

/**
 * Whether a response is a page of Favourites.
 *
 * The excluded list is checked first and unconditionally: a config that
 * accidentally lists the Likes endpoint must not be able to turn likes into
 * bookmarks.
 */
export function isFavouritesRequest(url: string, config: EndpointConfig): boolean {
	const path = pathOf(url);
	if (!path) return false;
	if (NOT_FAVOURITES.some((fragment) => path.includes(fragment))) return false;
	const watched = config.watchUrls ?? [];
	return watched.some((fragment) => fragment.length > 0 && path.includes(fragment));
}

export function isLikesRequest(url: string): boolean {
	const path = pathOf(url);
	return path !== null && NOT_FAVOURITES.some((f) => path.includes(f));
}

// ---- the page itself ------------------------------------------------------

type Any = Record<string, any>;

export interface ItemListPage {
	ids: string[];
	count: number;
	cursor: string | null;
	hasMore: boolean;
}

/**
 * Read a Favourites page.
 *
 * `hasMore` is what tells a scan whether there is anything left, which is a
 * far better answer than watching the page stop growing and hoping.
 */
export function readItemList(raw: unknown): ItemListPage {
	const root = raw as Any;
	const list: Any[] = Array.isArray(root?.itemList)
		? root.itemList
		: Array.isArray(root?.items)
			? root.items
			: [];
	const ids = list
		.map((item) => item?.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);

	const cursor =
		typeof root?.cursor === "string" && root.cursor.length > 0
			? root.cursor
			: typeof root?.cursor === "number"
				? String(root.cursor)
				: null;

	return {
		ids,
		count: ids.length,
		cursor,
		hasMore: root?.hasMore === true || root?.hasMore === 1,
	};
}

// ---- who is signed in -----------------------------------------------------

const HANDLE = /^[A-Za-z0-9_.]{1,24}$/;

/**
 * The signed-in handle, from the blob TikTok rehydrates its app with.
 *
 * This is what lets Import mean "open my Favourites" instead of "open TikTok
 * and hope you are on the right page". Both the current and the older shape
 * are read, because one install is not the same as another.
 */
export function readHandle(scope: unknown): string | null {
	const root = scope as Any;
	const candidates = [
		root?.__DEFAULT_SCOPE__?.["webapp.app-context"]?.user?.uniqueId,
		root?.["webapp.app-context"]?.user?.uniqueId,
		root?.AppContext?.user?.uniqueId,
		root?.__DEFAULT_SCOPE__?.["webapp.app-context"]?.uniqueId,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && HANDLE.test(candidate)) return candidate;
	}
	return null;
}

/**
 * Current TikTok builds no longer expose either hydration object, but keep a
 * stable navigation link to the signed-in account. Accept only TikTok profile
 * paths and run the result through the same handle validation as hydration.
 */
export function readHandleFromProfileHref(href: unknown): string | null {
	if (typeof href !== "string") return null;
	try {
		const parsed = new URL(href, "https://www.tiktok.com");
		if (parsed.hostname !== "www.tiktok.com" && parsed.hostname !== "tiktok.com") return null;
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length !== 1 || !parts[0]?.startsWith("@")) return null;
		const handle = parts[0].slice(1);
		return HANDLE.test(handle) ? handle : null;
	} catch {
		return null;
	}
}

export function profileUrl(handle: string): string | null {
	return HANDLE.test(handle) ? `https://www.tiktok.com/@${handle}` : null;
}

/** Whether a tab is already somewhere a Favourites scan can work. */
export function isProfileView(url: string, handle: string): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		if (host !== "www.tiktok.com" && host !== "tiktok.com") return false;
		const first = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
		return first.toLowerCase() === `@${handle.toLowerCase()}`;
	} catch {
		return false;
	}
}

/**
 * Where the Favourites tab is, in the order worth trying.
 *
 * TikTok's `data-e2e` attributes are its own test hooks and outlive its class
 * names by a wide margin, so they lead. The rest is a hedge, and if none of
 * them match the scan still runs against whatever the tab is showing.
 */
export const FAVOURITES_TAB_SELECTORS = [
	'[data-e2e="favorites-tab"]',
	'[data-e2e="favorite-tab"]',
	'[role="tab"][aria-label*="Favorite" i]',
	'[role="tab"][aria-label*="Favourite" i]',
];

// ---- mutations ------------------------------------------------------------

export interface MutationConfig {
	/** Path fragment of the favourite/unfavourite call, from server config. */
	mutationUrl?: string;
	/** Query or body field naming the video. */
	idField?: string;
	/** Field carrying the direction, and the value that means "saved". */
	actionField?: string;
	savedValue?: string;
}

export interface FavouriteMutation {
	action: "save" | "unsave";
	videoId: string;
}

/**
 * Read a favourite mutation, entirely as configured.
 *
 * Deliberately inert until the server says otherwise. TikTok's mutation
 * endpoint and its field names have not been confirmed against a current
 * authenticated request, and inventing them would produce an adapter that
 * looks finished and silently records nothing. When a real fixture settles the
 * shape, the config describes it and this starts working with no reinstall.
 */
export function readFavouriteMutation(
	url: string,
	body: unknown,
	config: MutationConfig,
): FavouriteMutation | null {
	if (!config.mutationUrl || !config.idField) return null;
	const path = pathOf(url);
	if (!path || !path.includes(config.mutationUrl)) return null;

	const fields = new URLSearchParams();
	try {
		for (const [key, value] of new URL(url, "https://www.tiktok.com")
			.searchParams) {
			fields.set(key, value);
		}
	} catch {
		return null;
	}
	if (typeof body === "string") {
		for (const [key, value] of new URLSearchParams(body)) fields.set(key, value);
	} else if (body instanceof URLSearchParams) {
		for (const [key, value] of body) fields.set(key, value);
	}

	const videoId = fields.get(config.idField);
	if (!videoId || !/^[0-9]{5,25}$/.test(videoId)) return null;

	if (!config.actionField) return { action: "save", videoId };
	const direction = fields.get(config.actionField);
	const saved = config.savedValue ?? "1";
	return { action: direction === saved ? "save" : "unsave", videoId };
}
