import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3001,
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
