import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  optimizeDeps: {
    exclude: ["cloudflare:workers", "bun:sqlite"],
  },
  ssr: {
    optimizeDeps: {
      exclude: ["@anansi/db/local", "bun:sqlite"],
    },
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers", "bun:sqlite"],
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflare({
      configPath: "../../wrangler.jsonc",
      // Match root Wrangler migration commands, regardless of Vite's cwd.
      persistState: { path: fileURLToPath(new URL("../../.wrangler/state", import.meta.url)) },
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
