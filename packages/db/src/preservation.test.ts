import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { toWebCapture } from "../../../apps/extension/lib/page-capture.ts";
import { toBookmarkCapture } from "../../../apps/extension/lib/chrome-bookmarks.ts";
import { applyCapture } from "./capture-events.ts";
import { setItemNote, setFavorite, saveCollection, listCollections, deleteCollection, removeItemTag, exportLibrary, restoreLibrary } from "./organization.ts";
import { upsertItems, tagItems, listTags, setArchived, type IngestItem } from "./queries.ts";
import { getItem, searchItems, searchItemsPage, listItems, InvalidSearchCursorError } from "./search.ts";
import { items, media } from "./schema.ts";
import { openTestDb } from "./test-db.ts";
import { openLocalDb } from "./local.ts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sample = (externalId: string, patch: Partial<IngestItem> = {}): IngestItem => ({ source: "web", externalId, url: `https://example.com/${externalId}`, kind: "article", title: "An article", body: "A description", savedAt: 100, savedAtIsExact: true, media: [], metrics: {}, raw: {}, links: [], ...patch });
const page = async (selection?: string, observedAt = 100) => {
  const result = await toWebCapture({ url: "https://example.com/article", title: "Useful article", description: "A useful description", text: "Heading\n\nquasarunique article content\n    code();\n\n- first\n- second", selection, image: "https://example.com/cover.png" }, { method: selection ? "context_menu" : "toolbar", observedAt });
  if (!result.ok) throw new Error("fixture rejected");
  return result.capture;
};

describe("preservation regressions", () => {
  test("migration backfills legacy raw article text and selections into the rebuilt index", async () => {
    const db = openLocalDb(":memory:");
    const directory = fileURLToPath(new URL("../drizzle/", import.meta.url));
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql") && Number(name.slice(0,4)) < 10).sort()) {
      db.$client.exec(readFileSync(`${directory}/${name}`, "utf8"));
    }
    db.$client.prepare("insert into items(id,source,external_id,url,kind,body,saved_at,raw) values (?,?,?,?,?,?,?,?)").run("legacy","web","legacy","https://example.com/legacy","article","Description",100,JSON.stringify({text:"legacyphraseunique\n    code();",selection:"legacy highlight"}));
    db.$client.exec(readFileSync(`${directory}/0010_preservation_organization.sql`, "utf8"));
    db.$client.exec(readFileSync(`${directory}/0012_tag_colors.sql`, "utf8"));
    expect((await getItem(db,"legacy"))?.fullText).toContain("legacyphraseunique");
    expect((await getItem(db,"legacy"))?.highlights[0]?.text).toBe("legacy highlight");
    expect((await searchItems(db,{query:"legacyphraseunique"}))[0]?.id).toBe("legacy");
  });

  test("rich page then Chrome mirror preserves searchable reader text, media and annotations", async () => {
    const db = openTestDb();
    const first = await applyCapture(db, await page());
    await setItemNote(db, first.itemId!, "Why I saved it");
    await setFavorite(db, [first.itemId!], true);
    await tagItems(db, [first.itemId!], "research");
    const [asset] = await db.select().from(media);
    await db.update(media).set({ storedKey: "kept/image.png" }).where(eq(media.id, asset!.id));
    const bookmark = await toBookmarkCapture({ id: "node", url: "https://example.com/article", title: "Browser title", dateAdded: 50_000 }, "save", 200);
    await applyCapture(db, bookmark!);
    const detail = await getItem(db, first.itemId!);
    expect(detail?.title).toBe("Useful article");
    expect(detail?.fullText).toContain("quasarunique");
    expect(detail?.fullText).toContain("    code();");
    expect(detail?.media[0]?.storedKey).toBe("kept/image.png");
    expect(detail?.note).toBe("Why I saved it");
    expect(detail?.favorite).toBe(true);
    expect(detail?.tags).toEqual(["research"]);
    const hit = (await searchItems(db, { query: "quasarunique" }))[0];
    expect(hit?.id).toBe(first.itemId!);
    expect(hit?.hasNote).toBe(true);
    expect(hit?.tags?.[0]?.label).toBe("research");
    expect(hit?.tags?.[0]?.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect((await listTags(db))[0]?.color).toBe(hit?.tags?.[0]?.color);
  });

  test("Chrome first then rich page then rename retains rich content", async () => {
    const db = openTestDb();
    const node = { id: "node", url: "https://example.com/article", title: "Browser title", dateAdded: 50_000 };
    const first = await applyCapture(db, (await toBookmarkCapture(node, "save", 90))!);
    await applyCapture(db, await page());
    await applyCapture(db, (await toBookmarkCapture({ ...node, title: "Renamed" }, "save", 200))!);
    expect((await getItem(db, first.itemId!))?.title).toBe("Useful article");
    expect((await getItem(db, first.itemId!))?.fullText).toContain("quasarunique");
  });

  test("two selections, repeat selection, and full page refresh keep two highlights", async () => {
    const db = openTestDb();
    const first = await applyCapture(db, await page("First selected paragraph"));
    await applyCapture(db, await page("Second selected paragraph", 101));
    await applyCapture(db, await page("First selected paragraph", 102));
    await applyCapture(db, await page(undefined, 103));
    const detail = await getItem(db, first.itemId!);
    expect(detail?.highlights.map(h => h.text)).toEqual(["First selected paragraph", "Second selected paragraph"]);
    expect((await searchItems(db, { query: '"Second selected paragraph"' })).length).toBe(1);
    expect((await listItems(db)).items.length).toBe(1);
  });

  test("multiple selections for the same identity in one import are retained", async () => {
    const db = openTestDb();
    await upsertItems(db, [sample("same", { raw: { selection: "first" } }), sample("same", { raw: { selection: "second" } })]);
    const [row] = await db.select().from(items);
    expect((await getItem(db, row!.id))?.highlights.length).toBe(2);
  });

  test("partial repository refresh cannot drop rich body, metadata or attachments", async () => {
    const db = openTestDb();
    await upsertItems(db, [sample("repo", { source: "github", body: "Description and an extensive useful README", authorAvatar: "https://example.com/avatar.png", raw: { readme: "Useful README", language: "TypeScript", topics: ["search"] }, media: [{kind:"image",originUrl:"https://example.com/cover.png"}] })]);
    await upsertItems(db, [sample("repo", { source: "github", body: "Description", raw: { language: null, topics: [] } })]);
    const [row] = await db.select().from(items);
    expect(row?.body).toContain("README");
    expect(JSON.parse(row!.raw).language).toBe("TypeScript");
    expect(JSON.parse(row!.raw).topics).toEqual(["search"]);
    expect((await db.select().from(media)).length).toBe(1);
  });
});

describe("filter-scoped retrieval and organization", () => {
  test("search parity for source, author, tags, media, archive, removed, favorites and pagination", async () => {
    const db = openTestDb();
    await upsertItems(db, Array.from({length:5}, (_,i) => sample(`item${i}`, {source:"github", kind:"repo", authorHandle:"jojo", body:"pagination example", media:[{kind:"image",originUrl:`https://example.com/${i}.png`}]})));
    await upsertItems(db, [sample("outside", {body:"pagination example"})]);
    const rows = await db.select().from(items).where(eq(items.source,"github"));
    await tagItems(db, rows.map(r=>r.id), "architecture");
    await setFavorite(db, rows.map(r=>r.id), true);
    const filters = {query:"architecture", source:"github", author:"jojo", tag:"architecture", media:"image", contentType:"repo", favorite:true, removed:"exclude" as const, limit:2};
    const seen: string[] = [];
    let cursor: string | undefined;
    do { const result = await searchItemsPage(db, {...filters,cursor}); seen.push(...result.items.map(r=>r.id)); cursor=result.nextCursor ?? undefined; } while(cursor);
    expect(seen.length).toBe(5); expect(new Set(seen).size).toBe(5);
    const first = await searchItemsPage(db, filters);
    await expect(searchItemsPage(db,{...filters, query:"pagination", cursor:first.nextCursor!})).rejects.toBeInstanceOf(InvalidSearchCursorError);
    await setArchived(db,[rows[0]!.id],true);
    expect((await searchItems(db,filters)).length).toBe(2); // limit remains 2
    expect((await searchItems(db,{...filters,limit:20})).length).toBe(4);
    expect((await searchItems(db,{...filters,archived:true})).length).toBe(1);
    await db.update(items).set({platformSaved:0}).where(eq(items.id,rows[1]!.id));
    expect((await searchItems(db,{...filters,limit:20})).length).toBe(3);
    expect((await searchItems(db,{...filters,removed:"only"})).length).toBe(1);
    await removeItemTag(db, rows[2]!.id, "architecture");
    expect((await searchItems(db,{query:"architecture",limit:20})).some(r=>r.id===rows[2]!.id)).toBe(false);
  });

  test("notes are searchable; collections update and delete; logical backup restores annotations", async () => {
    const db = openTestDb();
    const saved = await applyCapture(db,await page("Remember this"));
    await setItemNote(db,saved.itemId!,"notefindunique");
    await setFavorite(db,[saved.itemId!],true);
    await tagItems(db,[saved.itemId!],"ideas");
    expect((await searchItems(db,{query:"notefindunique"})).length).toBe(1);
    const collection = await saveCollection(db,{name:"Research",filters:{source:"web",tag:"ideas",query:"quasarunique"}});
    await saveCollection(db,{...collection,name:"Reading"});
    expect((await listCollections(db))[0]?.name).toBe("Reading");
    const backup=await exportLibrary(db);
    const restored=openTestDb(); await restoreLibrary(restored,backup);
    expect((await getItem(restored,saved.itemId!))?.note).toBe("notefindunique");
    expect((await getItem(restored,saved.itemId!))?.highlights[0]?.text).toBe("Remember this");
    expect((await getItem(restored,saved.itemId!))?.favorite).toBe(true);
    expect((await searchItems(restored,{query:"ideas"})).length).toBe(1);
    expect((await listCollections(restored))[0]?.name).toBe("Reading");
    await expect(restoreLibrary(restored,backup)).rejects.toThrow("empty library");
    await deleteCollection(db,collection.id); expect(await listCollections(db)).toEqual([]);
  });
});
