import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Anansi",
    action: { default_title: "Anansi" },
    description: "Sends what you save — bookmarks, stars, favourites and pages — to your own Anansi library.",
    // storage for the server/token, tabs to find the logged-in x.com tab.
    // Deliberately no <all_urls>: broad permissions are the single biggest
    // driver of review scrutiny, and this needs exactly two hosts.
    // alarms for the scheduler. Still no <all_urls>, still no cookies: the
    // cookie grant would let capture run without an open tab, and that is a
    // much broader permission than the convenience is worth.
    // activeTab/scripting/contextMenus are what let "save this page" work on
    // any site without asking for every site: pressing the button or a menu
    // item grants this extension that one tab, for that one moment, and it
    // lapses. <all_urls> would buy the same feature by letting it read every
    // page you ever open, which is not a trade worth making for a button.
    permissions: ["storage", "tabs", "alarms", "activeTab", "scripting", "contextMenus"],
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
      "https://www.tiktok.com/*",
      "https://tiktok.com/*",
      // Where your library lives. Loopback covers local development; replace
      // with your Worker origin before shipping to anyone else.
      "http://127.0.0.1/*",
      "http://localhost/*",
      "https://*.workers.dev/*",
    ],
  },
});
