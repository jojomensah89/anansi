import { useEffect, useRef, useState } from "react";
import type { ItemRow } from "../lib/api.ts";

/**
 * Column packing for a grid of unequal cards.
 *
 * CSS grid cannot do this: its rows are as tall as their tallest member, so a
 * 137px card beside a 535px one leaves 400px of hole. CSS `columns` can, but
 * it reflows every card across every column each time a page is appended —
 * under infinite scroll that means the thing you were reading jumps somewhere
 * else mid-scroll.
 *
 * So columns are assigned in JS, shortest-first, and only ever appended to.
 * An item that has been placed never moves. The height is estimated rather
 * than measured, which is wrong by a few pixels and right about the ordering
 * — and ordering is all that packing needs.
 */
export function useColumnCount(ref: React.RefObject<HTMLElement | null>, min = 280): number {
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      setColumns(Math.max(1, Math.floor((width + 14) / (min + 14))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, min]);

  return columns;
}

/**
 * Roughly how tall a card will be, in the same units for every card.
 *
 * Only the relative values matter — the shortest column stays the shortest
 * whether the unit is pixels or furlongs.
 */
function estimate(item: ItemRow, columnWidth: number): number {
  const media = item.media ?? [];
  let height = 92; // header, footer, padding

  if (media.length === 1) height += columnWidth * 0.62;
  else if (media.length === 2) height += columnWidth * 0.5;
  else if (media.length === 3) height += columnWidth * 1.0;
  else if (media.length >= 4) height += columnWidth;

  // ~28 characters a line at this width, 20px a line, clamped where the card
  // clamps.
  const lines = Math.min(Math.ceil(item.excerpt.length / 28), media.length ? 4 : 8);
  height += lines * 20;

  if (item.quoted) {
    height += 62 + Math.min(Math.ceil(item.quoted.text.length / 32), 3) * 18;
    if (item.quoted.media.length) height += columnWidth * (item.quoted.media.length > 1 ? 0.42 : 0.5);
  }

  return height;
}

export function packColumns(items: ItemRow[], columns: number, columnWidth: number): ItemRow[][] {
  const buckets: ItemRow[][] = Array.from({ length: columns }, () => []);
  const heights = new Array(columns).fill(0);

  for (const item of items) {
    let shortest = 0;
    for (let i = 1; i < columns; i++) if (heights[i] < heights[shortest]) shortest = i;
    buckets[shortest]!.push(item);
    heights[shortest] += estimate(item, columnWidth) + 14;
  }

  return buckets;
}

/** The measured container plus its packed columns, ready to render. */
export function useMasonry(items: ItemRow[], min = 280) {
  const ref = useRef<HTMLDivElement>(null);
  const columns = useColumnCount(ref, min);
  const width = (ref.current?.clientWidth ?? min * columns) / columns;
  return { ref, columns, buckets: packColumns(items, columns, width) };
}
