import { useContext, useEffect } from "react";
import { useQuery, QueryClientContext, QueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

/**
 * Topic colour.
 *
 * AI topics get one small dot each, and the dot is the only colour a tag ever
 * carries. The hue is chosen here, not stored: a stable index into a calm
 * ten-step palette (`--topic-0` … `--topic-9` in styles/frame.css, tuned per
 * theme), so a topic is the same colour on a card, in the filter menu and in
 * the inspector. The owner's own tags stay neutral and have no dot.
 *
 * Tag summaries on cards carry a label and no id, and topic labels are unique
 * and canonical, so the label is the key.
 */
export const TOPIC_PALETTE_SIZE = 10;

/**
 * The v2 taxonomy has nineteen topics and the palette ten colours, so each
 * colour is shared by two topics chosen to rarely meet on one screen. A topic
 * the table does not know (a later taxonomy) falls back to a stable hash.
 */
const TOPIC_SLOTS: Record<string, number> = {
	finance: 0, lifestyle: 0,
	"web dev": 1, music: 1,
	design: 2, "food & travel": 2,
	marketing: 3, gaming: 3,
	security: 4, "entertainment & anime": 4,
	product: 5, health: 5,
	career: 6, learning: 6,
	startups: 7, "hardware & networking": 7,
	devops: 8, science: 8,
	"ai / ml": 9,
};

export function topicColorIndex(key: string): number {
	const text = key.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
	const slot = TOPIC_SLOTS[text];
	if (slot !== undefined) return slot;
	// FNV-1a: tiny, stable across sessions and runtimes.
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % TOPIC_PALETTE_SIZE;
}

export function topicColor(key: string): string {
	return `var(--topic-${topicColorIndex(key)})`;
}

/* --------------------------------------------------------- tag kinds --- */

/**
 * Which labels are AI topics.
 *
 * One small shared store rather than a query per chip: a grid shows hundreds
 * of chips, and the answer only changes when a new topic is first used. Before
 * it arrives every chip renders neutral, which is also the right fallback when
 * the request fails.
 */
type Kinds = ReadonlyMap<string, "topic" | "custom">;

const EMPTY: Kinds = new Map();
const standaloneClient = new QueryClient();
const clients = new Map<QueryClient, number>();
function keyOf(label: string): string { return label.trim().toLowerCase(); }
const selectKinds = (data: Awaited<ReturnType<typeof api.tags>>): Kinds =>
 new Map(data.tags.map(tag => [keyOf(tag.label), tag.kind]));

/** Compatibility for callers that already have fresh tag data. */
export function setTagKinds(tags: { label: string; kind: "topic" | "custom" }[]): void {
 for (const client of clients.keys()) client.setQueryData(["tags"], { tags });
}
/** Existing edit handlers now invalidate the same cache as every tag query. */
export function refreshTagKinds(force = false): void {
 for (const client of clients.keys()) {
  if (force) void client.invalidateQueries({ queryKey: ["tags"] });
  else void client.prefetchQuery({ queryKey: ["tags"], queryFn: ({ signal }) => api.tags(signal), staleTime: 60_000 });
 }
}
export function useTagKinds(): Kinds {
 const providerClient = useContext(QueryClientContext);
 const client = providerClient ?? standaloneClient;
 useEffect(() => {
  if (!providerClient) return;
  clients.set(client, (clients.get(client) ?? 0) + 1);
  return () => { const count = (clients.get(client) ?? 1) - 1; if (count) clients.set(client, count); else clients.delete(client); };
 }, [client, providerClient]);
 return useQuery({ queryKey: ["tags"], queryFn: ({ signal }) => api.tags(signal), select: selectKinds, staleTime: 60_000, retry: false, enabled: !!providerClient }, client).data ?? EMPTY;
}

export function isTopic(kindsMap: Kinds, label: string): boolean {
	return kindsMap.get(keyOf(label)) === "topic";
}
