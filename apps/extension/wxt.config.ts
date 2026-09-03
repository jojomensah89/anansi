import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Anansi",
    action: { default_title: "Anansi" },
    description: "Sends your X bookmarks to your own Anansi library.",
    // storage for the server/token, tabs to find the logged-in x.com tab.
    // Deliberately no <all_urls>: broad permissions are the single biggest
    // driver of review scrutiny, and this needs exactly two hosts.
    // alarms for the scheduler. Still no <all_urls>, still no cookies: the
    // cookie grant would let capture run without an open tab, and that is a
    // much broader permission than the convenience is worth.
    permissions: ["storage", "tabs", "alarms"],
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
