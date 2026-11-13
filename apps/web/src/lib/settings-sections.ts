/**
 * The areas of Settings, each at its own URL (`/settings/<id>`).
 *
 * Kept free of components so the frame's breadcrumb, the settings nav and
 * the redirect for old links all read one list.
 */
export const SETTINGS_SECTIONS = [
	{ id: "library", label: "Library", lead: "Sync, sources and what the library shows" },
	{ id: "ai", label: "AI", lead: "Tagging, search by meaning and topics" },
	{ id: "agents", label: "Agents", lead: "The MCP server and the apps that use it" },
	{ id: "security", label: "Security", lead: "Passkeys and signing in" },
	{ id: "data", label: "Data", lead: "Export and restore your library" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "library";

/** Anchors from the single-page settings, so old links still land in the right place. */
const LEGACY_HASHES: Record<string, SettingsSectionId> = {
	sync: "library",
	display: "library",
	ai: "ai",
	"sign-in": "security",
	data: "data",
};

export function settingsSection(id: string | undefined | null): (typeof SETTINGS_SECTIONS)[number] | undefined {
	return SETTINGS_SECTIONS.find((section) => section.id === id);
}

/** Where `/settings` (with or without an old `#hash`) should go. */
export function settingsSectionForHash(hash: string | undefined | null): SettingsSectionId {
	const key = (hash ?? "").replace(/^#/, "");
	return settingsSection(key)?.id ?? LEGACY_HASHES[key] ?? DEFAULT_SETTINGS_SECTION;
}
