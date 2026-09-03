/**
 * Reddit saved posts and comments.
 *
 * Simpler than X in every way that matters, and the isolated world is enough:
 * there is no queryId buried in a lazily-loaded chunk, so nothing here needs
 * to share Reddit's JavaScript context. A content script's same-origin fetch
 * already carries the session cookies, and extension APIs are available, so
 * this talks to the background worker directly rather than through a relay.
 *
 * It still parses nothing. Raw listings go up exactly as Reddit returned them.
 */

interface RedditConfig {
  source: string;
  url: string;
  cursorParam: string;
  cursorPath: string;
  pageLimit: number;
}

export default defineContentScript({
  matches: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  runAt: "document_idle",

  main() {
    const dig = (obj: unknown, path: string): unknown =>
      path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], obj);

    /**
     * `/user/me/...` is not a real Reddit route — `me` only resolves on the
     * `/api/v1/me` family. So the username is looked up once and substituted.
     */
    const resolveUrl = async (template: string): Promise<string> => {
      if (!template.includes("/user/me/")) return template;
      const res = await fetch("/api/me.json", { credentials: "include" });
      if (!res.ok) throw new Error(`could not identify you (${res.status}) — signed in?`);
      const body = (await res.json()) as { data?: { name?: string } };
      const name = body?.data?.name;
      if (!name) throw new Error("could not identify you — signed in?");
      return template.replace("/user/me/", `/user/${name}/`);
    };

    const backfill = async (config: RedditConfig) => {
      const send = (msg: Record<string, unknown>) =>
        browser.runtime.sendMessage({ anansi: msg.anansi, source: config.source, ...msg });

      try {
        const base = await resolveUrl(config.url);
        let after: string | null = null;
        let page = 0;
        let total = 0;

        for (;;) {
          const url = new URL(base, location.origin);
          if (after) url.searchParams.set(config.cursorParam, after);

          const res = await fetch(url.toString(), {
            credentials: "include",
            headers: { accept: "application/json" },
          });

          if (res.status === 429) {
            // Reddit is stricter than X here and says so in a header.
            const wait = Number(res.headers.get("retry-after")) * 1000 || 10_000;
            await new Promise((r) => setTimeout(r, Math.min(wait, 120_000)));
            continue;
          }
          if (!res.ok) {
            await send({ anansi: "error", message: `reddit returned ${res.status}` });
            return;
          }

          const raw = await res.json();
          const children = (dig(raw, "data.children") as unknown[] | undefined) ?? [];
          page++;
          total += children.length;

          await send({ anansi: "page", raw, page, items: children.length });

          const next = dig(raw, config.cursorPath) as string | null;
          if (children.length === 0 || !next || next === after || page >= config.pageLimit) break;
          after = next;
        }

        await send({ anansi: "done", pages: page, items: total });
      } catch (err) {
        await send({ anansi: "error", message: (err as Error).message });
      }
    };

    browser.runtime.onMessage.addListener((message: unknown) => {
      const msg = message as { anansi?: string; config?: RedditConfig } | undefined;
      if (msg?.anansi === "backfill" && msg.config?.source === "reddit") {
        void backfill(msg.config);
      }
      return undefined;
    });
  },
});
