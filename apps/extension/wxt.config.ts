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
    permissions: ["storage", "tabs"],
    host_permissions: [
      "https://x.com/*",
      "https://twitter.com/*",
      // Where your library lives. Loopback covers local development; replace
      // with your Worker origin before shipping to anyone else.
      "http://127.0.0.1/*",
      "http://localhost/*",
      "https://*.workers.dev/*",
    ],
  },
});
