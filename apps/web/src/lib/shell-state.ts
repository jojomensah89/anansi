import { useSyncExternalStore } from "react";

/**
 * State the app shell and a page share without threading props through the
 * router: whether ⌘K is open, and which saves are picked in Select mode.
 *
 * Both are tiny stores read with useSyncExternalStore, the same shape as the
 * shelf dialog's request in shelves.ts, so any component can read or change
 * them and only its own readers re-render.
 */

function createStore<T>(initial: T) {
	let value = initial;
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	return {
		get: () => value,
		set(next: T | ((previous: T) => T)) {
			const resolved = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
			if (Object.is(resolved, value)) return;
			value = resolved;
			for (const listener of listeners) listener();
		},
		use: <S,>(select: (value: T) => S): S => useSyncExternalStore(subscribe, () => select(value), () => select(initial)),
	};
}

/* ------------------------------------------------------------ palette --- */

const palette = createStore(false);

export const openPalette = () => palette.set(true);
export const closePalette = () => palette.set(false);
export const usePaletteOpen = () => palette.use((open) => open);

/* ---------------------------------------------------------- selection --- */

export interface Selection {
	selecting: boolean;
	picked: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();
const selection = createStore<Selection>({ selecting: false, picked: NONE });

export const useSelecting = () => selection.use((state) => state.selecting);
export const usePicked = () => selection.use((state) => state.picked);
/** One card's pick, as a boolean: only cards whose answer changes re-render. */
export const useIsPicked = (id: string) => selection.use((state) => state.selecting && state.picked.has(id));

/** Enter or leave Select mode; either way starts from nothing picked. */
export function setSelecting(selecting: boolean) {
	selection.set({ selecting, picked: NONE });
}

export function toggleSelecting() {
	setSelecting(!selection.get().selecting);
}

/** Stable, so a memoised card can take it as a prop. */
export function togglePicked(item: { id: string }) {
	selection.set((state) => {
		const picked = new Set(state.picked);
		if (picked.has(item.id)) picked.delete(item.id);
		else picked.add(item.id);
		return { ...state, picked };
	});
}

export function setPicked(ids: Iterable<string>) {
	selection.set((state) => ({ ...state, picked: new Set(ids) }));
}

export function clearPicked() {
	selection.set((state) => (state.picked.size === 0 ? state : { ...state, picked: NONE }));
}
