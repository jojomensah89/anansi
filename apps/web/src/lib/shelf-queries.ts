import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type ItemRow, type Page, type Shelf, type ShelfInput } from "./api.ts";
import { libraryKeys } from "./library-query.ts";
import { adjustCount, chunk, moveShelf, shelfKeys, sortShelves, toggleMembership } from "./shelves.ts";

/**
 * Shelf data and the changes to it, through react-query.
 *
 * Every change is drawn first and confirmed after: the rail reorders under the
 * pointer, a check mark lands when it is clicked, a save leaves the shelf view
 * as it is taken off. A failure puts the old state back and says so in a toast.
 */

type ShelfList = { shelves: Shelf[] };
type Detail = Awaited<ReturnType<typeof api.item>>;
type Pages = { pages: Page[]; pageParams: unknown[] };

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : "The request failed.");

export function useShelves() {
	return useQuery({
		queryKey: shelfKeys.list(),
		queryFn: ({ signal }) => api.shelves(signal),
		select: (data: ShelfList) => sortShelves(data.shelves),
		staleTime: 30_000,
		retry: 1,
	});
}

export function useShelfSuggestions(enabled = true) {
	return useQuery({
		queryKey: shelfKeys.suggestions(),
		queryFn: ({ signal }) => api.shelfSuggestions(signal),
		staleTime: 5 * 60_000,
		retry: 0,
		enabled,
	});
}

/* ------------------------------------------------------------ reorder --- */

/** Draw the new order now; hand back what to restore if the server says no. */
export function applyReorder(client: QueryClient, id: string, to: number): { previous: ShelfList | undefined; ids: string[] } {
	const previous = client.getQueryData<ShelfList>(shelfKeys.list());
	const next = moveShelf(previous?.shelves ?? [], id, to);
	client.setQueryData<ShelfList>(shelfKeys.list(), { shelves: next });
	return { previous, ids: next.map((shelf) => shelf.id) };
}

export function useReorderShelves() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ ids }: { id: string; to: number; ids: string[] }) => api.reorderShelves(ids),
		onMutate: async () => {
			await client.cancelQueries({ queryKey: shelfKeys.list() });
		},
		onSuccess: (result) => client.setQueryData<ShelfList>(shelfKeys.list(), { shelves: result.shelves }),
		onError: (error, _vars, context) => {
			void context;
			void client.invalidateQueries({ queryKey: shelfKeys.list() });
			toast.error("Couldn't reorder shelves", { description: message(error) });
		},
	});
}

/** Reorder in one call: optimistic draw, then the request, rolled back on failure. */
export function useMoveShelf() {
	const client = useQueryClient();
	const reorder = useReorderShelves();
	return (id: string, to: number) => {
		const { previous, ids } = applyReorder(client, id, to);
		reorder.mutate({ id, to, ids }, {
			onError: () => {
				if (previous) client.setQueryData(shelfKeys.list(), previous);
			},
		});
	};
}

/* --------------------------------------------------------- membership --- */

export interface MembershipChange {
	shelf: Pick<Shelf, "id" | "name">;
	itemIds: string[];
	on: boolean;
}

interface MembershipSnapshot {
	list: ShelfList | undefined;
	details: [readonly unknown[], Detail | undefined][];
	pages: [readonly unknown[], Pages | undefined][];
}

function shelfPageKeys(client: QueryClient, shelfId: string) {
	return client
		.getQueriesData<Pages>({ queryKey: libraryKeys.pages() })
		.filter(([key]) => (key[2] as { shelf?: string } | undefined)?.shelf === shelfId);
}

/**
 * Draw a membership change before the server confirms it.
 *
 * The inspector's check marks follow the item's `shelves`; a single save whose
 * membership is known moves the shelf's count by one; a save taken off the
 * shelf being viewed leaves the grid at once.
 */
export function applyMembership(client: QueryClient, { shelf, itemIds, on }: MembershipChange): MembershipSnapshot {
	const snapshot: MembershipSnapshot = { list: client.getQueryData<ShelfList>(shelfKeys.list()), details: [], pages: [] };
	let delta = 0;
	for (const id of itemIds) {
		const key = libraryKeys.detail(id);
		const old = client.getQueryData<Detail>(key);
		snapshot.details.push([key, old]);
		if (!old) continue;
		const was = (old.shelves ?? []).includes(shelf.id);
		if (was !== on) delta += on ? 1 : -1;
		client.setQueryData<Detail>(key, { ...old, shelves: toggleMembership(old.shelves, shelf.id, on) });
	}
	if (delta && snapshot.list) client.setQueryData<ShelfList>(shelfKeys.list(), { shelves: adjustCount(snapshot.list.shelves, shelf.id, delta) });
	if (!on) {
		const gone = new Set(itemIds);
		for (const [key, data] of shelfPageKeys(client, shelf.id)) {
			snapshot.pages.push([key, data]);
			if (!data) continue;
			client.setQueryData<Pages>(key, {
				...data,
				pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item: ItemRow) => !gone.has(item.id)) })),
			});
		}
	}
	return snapshot;
}

export function restoreMembership(client: QueryClient, snapshot: MembershipSnapshot): void {
	if (snapshot.list) client.setQueryData(shelfKeys.list(), snapshot.list);
	for (const [key, data] of snapshot.details) if (data) client.setQueryData(key, data);
	for (const [key, data] of snapshot.pages) client.setQueryData(key, data);
}

/** Cancel an earlier list fetch before writing the authoritative membership count. */
export async function sendMembershipAndCache(client: QueryClient, change: MembershipChange) {
 try {
  const result = await sendMembership(change);
  await client.cancelQueries({ queryKey: shelfKeys.list() });
  if (result.shelf) {
   const shelf = result.shelf;
   client.setQueryData<ShelfList>(shelfKeys.list(), old => ({ shelves: (old?.shelves ?? []).some(s => s.id === shelf.id)
    ? old!.shelves.map(s => s.id === shelf.id ? shelf : s) : [...(old?.shelves ?? []), shelf] }));
  }
  return result;
 } finally {
  void client.invalidateQueries({ queryKey: shelfKeys.list() });
 }
}

/** Up to 500 ids per request, in order; the last reply carries the shelf's new count. */
export async function sendMembership({ shelf, itemIds, on }: MembershipChange): Promise<{ changed: number; shelf: Shelf | null }> {
	let changed = 0;
	let latest: Shelf | null = null;
	for (const ids of chunk(itemIds)) {
		const result = await api.shelfItems(shelf.id, ids, on ? "add" : "remove");
		changed += result.changed;
		latest = result.shelf;
	}
	return { changed, shelf: latest };
}

const plural = (n: number) => `${n.toLocaleString("en-GB")} save${n === 1 ? "" : "s"}`;

/**
 * Put saves on a shelf or take them off.
 *
 * `quiet` skips the toast for a single check mark, which is its own feedback.
 * Taking saves off always offers Undo, because on a shelf with a rule it also
 * keeps them off.
 */
export function useShelfMembership() {
	const client = useQueryClient();
	const mutation = useMutation({
		mutationFn: (change: MembershipChange & { quiet?: boolean }) => sendMembership(change),
		onMutate: async (change) => {
			await client.cancelQueries({ queryKey: shelfKeys.list() });
			return applyMembership(client, change);
		},
		onError: (error, change, snapshot) => {
			if (snapshot) restoreMembership(client, snapshot);
			toast.error(change.on ? `Couldn't add to ${change.shelf.name}` : `Couldn't remove from ${change.shelf.name}`, { description: message(error) });
		},
		onSuccess: (result, change) => {
			if (result.shelf) {
				const list = client.getQueryData<ShelfList>(shelfKeys.list());
				if (list) client.setQueryData<ShelfList>(shelfKeys.list(), { shelves: list.shelves.map((entry) => (entry.id === result.shelf!.id ? result.shelf! : entry)) });
			}
			const count = change.itemIds.length;
			if (!change.on) {
				toast(`Removed ${count === 1 ? "" : `${plural(count)} `}from ${change.shelf.name}`, {
					action: { label: "Undo", onClick: () => mutation.mutate({ ...change, on: true, quiet: true }) },
				});
			} else if (!change.quiet) {
				toast.success(`Added ${plural(count)} to ${change.shelf.name}`);
			}
		},
		onSettled: (_result, _error, change) => {
			for (const [key] of shelfPageKeys(client, change.shelf.id)) void client.invalidateQueries({ queryKey: key, exact: true });
			if (change.itemIds.length === 1) void client.invalidateQueries({ queryKey: libraryKeys.detail(change.itemIds[0]!), exact: true });
		},
	});
	return mutation;
}

/* ----------------------------------------------------- create, edit, delete --- */

export function useSaveShelf() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ id, input }: { id?: string; input: ShelfInput & { name: string } }) =>
			id ? api.updateShelf(id, input) : api.createShelf(input),
		onSuccess: ({ shelf }) => {
			const list = client.getQueryData<ShelfList>(shelfKeys.list());
			const shelves = list?.shelves ?? [];
			const next = shelves.some((entry) => entry.id === shelf.id) ? shelves.map((entry) => (entry.id === shelf.id ? shelf : entry)) : [...shelves, shelf];
			client.setQueryData<ShelfList>(shelfKeys.list(), { shelves: next });
			void client.invalidateQueries({ queryKey: shelfKeys.list() });
			void client.invalidateQueries({ queryKey: shelfKeys.suggestions() });
			for (const [key] of shelfPageKeys(client, shelf.id)) void client.invalidateQueries({ queryKey: key, exact: true });
		},
	});
}

export function useRenameShelf() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => api.updateShelf(id, { name }),
		onMutate: async ({ id, name }) => {
			await client.cancelQueries({ queryKey: shelfKeys.list() });
			const previous = client.getQueryData<ShelfList>(shelfKeys.list());
			if (previous) client.setQueryData<ShelfList>(shelfKeys.list(), { shelves: previous.shelves.map((shelf) => (shelf.id === id ? { ...shelf, name } : shelf)) });
			return previous;
		},
		onError: (error, _vars, previous) => {
			if (previous) client.setQueryData(shelfKeys.list(), previous);
			toast.error("Couldn't rename the shelf", { description: message(error) });
		},
	});
}

export function useDeleteShelf() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (shelf: Shelf) => api.deleteShelf(shelf.id),
		onMutate: async (shelf) => {
			await client.cancelQueries({ queryKey: shelfKeys.list() });
			const previous = client.getQueryData<ShelfList>(shelfKeys.list());
			if (previous) client.setQueryData<ShelfList>(shelfKeys.list(), { shelves: previous.shelves.filter((entry) => entry.id !== shelf.id) });
			return previous;
		},
		onError: (error, _shelf, previous) => {
			if (previous) client.setQueryData(shelfKeys.list(), previous);
			toast.error("Couldn't delete the shelf", { description: message(error) });
		},
		onSuccess: (_result, shelf) => {
			toast(`Deleted ${shelf.name}`);
			void client.invalidateQueries({ queryKey: shelfKeys.suggestions() });
		},
	});
}

export function useDismissSuggestion() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (topic: string) => api.dismissShelfSuggestion(topic),
		onMutate: async (topic) => {
			await client.cancelQueries({ queryKey: shelfKeys.suggestions() });
			const previous = client.getQueryData<{ suggestions: { topic: string }[] }>(shelfKeys.suggestions());
			if (previous) client.setQueryData(shelfKeys.suggestions(), { suggestions: previous.suggestions.filter((entry) => entry.topic !== topic) });
			return previous;
		},
		onError: (error, _topic, previous) => {
			if (previous) client.setQueryData(shelfKeys.suggestions(), previous);
			toast.error("Couldn't dismiss the suggestion", { description: message(error) });
		},
	});
}
