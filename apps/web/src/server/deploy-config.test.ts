import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const root = new URL("../../../../", import.meta.url);
test("button deployment pins Bun and applies canonical SQL migrations before publishing", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  expect(pkg.packageManager).toBe("bun@1.4.2");
  expect(pkg.scripts.deploy).toBe("bun run db:migrate:remote && wrangler deploy --config apps/web/dist/server/wrangler.json");
  expect(pkg.scripts["db:migrate:remote"]).toBe("wrangler d1 migrations apply DB --remote");
  expect(readFileSync(new URL("wrangler.jsonc", root), "utf8")).toContain('"migrations_dir": "packages/db/drizzle"');
});
