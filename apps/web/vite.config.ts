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
  server: {
    port: 3001,
    proxy: localProxy,
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
