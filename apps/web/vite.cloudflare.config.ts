import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
