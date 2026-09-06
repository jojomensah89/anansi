import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { connectionForWxtConfig } from "./lib/connection.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(repoRoot, ".env"), quiet: true });

const connection = connectionForWxtConfig(
	process.env.ANANSI_EXTENSION_ORIGIN,
	process.env.ANANSI_EXTENSION_INGEST_TOKEN,
	process.argv[2],
);

export default defineConfig({
	modules: ["@wxt-dev/module-react"],
	vite: () => ({
		define: {
			__ANANSI_EXTENSION_ORIGIN__: JSON.stringify(connection.origin),
			__ANANSI_EXTENSION_INGEST_TOKEN__: JSON.stringify(connection.token),
		},
	}),
	manifest: {
		name: "Anansi",
		action: { default_title: "Anansi" },
		description:
			"Sends what you save — bookmarks, stars, favorites and pages — to your own Anansi library.",
		// Storage holds durable operational state; the private build connection is
		// immutable. Tabs and alarms support page capture and recovery/scheduling.
		// GitHub and Reddit worker fetches use the host
		// permissions below with credentials: include; no cookies API is needed.
		// activeTab/scripting/contextMenus are what let "save this page" work on
		// any site without asking for every site: pressing the button or a menu
		// item grants this extension that one tab, for that one moment, and it
		// lapses. <all_urls> would buy the same feature by letting it read every
		// page you ever open, which is not a trade worth making for a button.
		permissions: [
			"storage",
			"tabs",
			"alarms",
			"activeTab",
			"scripting",
			"contextMenus",
		],
		// Optional, and asked for only when Chrome mirroring is switched on. Your
		// whole browsing life is legible from a bookmark tree; an extension that
		// reads it because it might one day be asked to is taking far more than it
		// needs. Turning mirroring off hands the permission back.
		optional_permissions: ["bookmarks"],
		host_permissions: [
			"https://x.com/*",
			"https://twitter.com/*",
			"https://www.reddit.com/*",
			"https://old.reddit.com/*",
			"https://reddit.com/*",
			"https://github.com/*",
			`${connection.origin}/*`,
		],
	},
});
