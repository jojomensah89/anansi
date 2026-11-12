import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { ItemRow } from "../lib/api.ts";

/**
 * Measure before paint in the browser, and do nothing during SSR.
 *
 * useEffect runs after the frame, so the column count would be 1 for one paint
 * and then four — a visible snap on every load. useLayoutEffect runs first,
 * but warns if it runs on the server, where there is nothing to measure.
 */
const useMeasure = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Column packing for a grid of unequal cards.
 *
 * CSS grid cannot do this: its rows are as tall as their tallest member, so a
 * 137px card beside a 535px one leaves 400px of hole. CSS `columns` can, but
 * it fills column one top to bottom before column two, and reflows every card
 * each time a page is appended.
 *
 * So columns are assigned in JS, round-robin: card n goes to column
 * n % columns. Read across, every row is in library order, the same order as
 * the timeline. Shortest-column packing was tighter but scrambled that order,
 * since a tall card pushed the next saves into other rows. Cards are only ever
 * appended, so a placed card never moves.
 */
/**
 * A callback ref, not a RefObject, and that distinction is the whole point.
 *
 * With a RefObject the measuring effect runs once on mount — when the element
 * does not exist yet — and its dependencies never change, so it never runs
 * again. Whichever element attached later (the skeleton, then the grid) was
 * never measured, and a four-column layout rendered as one long column.
 *
 * Holding the node in state means attaching an element *is* the change that
 * triggers the measure, whenever it happens and however many times.
 */
export function useColumnCount(min = 280) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(1);

  const ref = useCallback((element: HTMLDivElement | null) => setNode(element), []);

  useMeasure(() => {
    if (!node) return;
    const measure = () => {
      setColumns(Math.max(1, Math.floor((node.clientWidth + 14) / (min + 14))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, min]);

  return { ref, columns, node };
}

export function packColumns(items: ItemRow[], columns: number): ItemRow[][] {
  const buckets: ItemRow[][] = Array.from({ length: columns }, () => []);
  items.forEach((item, index) => buckets[index % columns]!.push(item));
  return buckets;
}

/** The measured container plus its packed columns, ready to render. */
export function useMasonry(items: ItemRow[], min = 280) {
  const { ref, columns } = useColumnCount(min);
  return { ref, columns, buckets: packColumns(items, columns) };
}
