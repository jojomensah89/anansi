import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export const LOCAL_API_ORIGIN = "http://127.0.0.1:8788";

export const localProxy = {
  "/api": { target: LOCAL_API_ORIGIN },
  "/mcp": { target: LOCAL_API_ORIGIN },
} as const;

export default defineConfig({
  optimizeDeps: {
    // Runtime-provided modules. Neither exists in Vite's Node dependency
    // graph, and scanning them makes local development report a false missing
    // dependency before the runtime adapter has been selected.
    exclude: ["cloudflare:workers", "bun:sqlite"],
  },
  ssr: {
    // The local runtime adapter is a reachable dynamic-import branch during
    // Bun development, but it must stay out of Alchemy's workerd optimizer.
    // The Worker takes the cloudflare:workers branch and never evaluates it.
    optimizeDeps: {
      exclude: ["@anansi/db/local", "bun:sqlite"],
    },
    external: ["@anansi/db/local", "bun:sqlite"],
  },
  server: {
    port: 3001,
    // Alchemy's Cloudflare runtime owns /api and /mcp during hosted dev. The
    // proxy is only for the standalone Vite UI paired with serve-local.
    ...(process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1" ? {} : { proxy: localProxy }),
  },
  build: {
    rollupOptions: {
      // resolved by workerd at runtime; node builds cannot bundle it
      // Neither resolves in the other runtime; env.ts imports both dynamically.
      external: ["cloudflare:workers", "bun:sqlite"],
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
