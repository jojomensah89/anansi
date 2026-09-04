import { useEffect, useState } from "react";

/**
 * Placeholders shaped like the thing that is coming.
 *
 * Two rules, and both are about not making the wait worse than it is.
 *
 * A skeleton is the shape of the real content, not a generic grey box: the
 * point is that nothing moves when the data lands. A card skeleton is a card,
 * a row skeleton is a row, and a count is as wide as a count.
 *
 * And a skeleton that appears for eighty milliseconds is worse than no
 * skeleton at all — it reads as a flicker, or a bug. This library is a local
 * SQLite file, so most loads are far too fast to be worth announcing. Nothing
 * here shows until the wait is long enough to be one, which is what
 * `useSlowLoad` is for.
 */

/** How long a load may take before it is worth drawing anything about it. */
const NOTICEABLE_MS = 140;

/**
 * True only once a load has gone on long enough to be perceived.
 *
 * Returns false for a fast load from first render to last, so the fast path
 * renders exactly nothing rather than a frame of grey.
 */
export function useSlowLoad(loading: boolean, delay = NOTICEABLE_MS): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), delay);
    return () => clearTimeout(timer);
  }, [loading, delay]);

  return slow;
}

export interface BoneProps {
  width?: number | string;
  height?: number;
  radius?: number;
  /** Staggers the shimmer so a column does not pulse as one block. */
  delay?: number;
  style?: React.CSSProperties;
}

/**
 * One placeholder shape.
 *
 * `aria-hidden`, because a screen reader should hear the loading state once
 * from the region that owns it, not once per grey rectangle.
 */
export function Bone({ width = "100%", height = 12, radius = 4, delay = 0, style }: BoneProps) {
  return (
    <span
      aria-hidden="true"
      className="bone"
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
        animationDelay: `${delay}ms`,
        ...style,
      }}
    />
  );
}

/**
 * The region wrapper.
 *
 * `aria-busy` with a live region is what actually tells a screen reader
 * something is happening; the shapes themselves are decoration.
 */
export function Loading({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: "contents" }}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- cards --- */

/**
 * Heights vary deliberately.
 *
 * The grid packs cards of mixed height, so a column of identical rectangles
 * would be a promise the real content immediately breaks.
 */
const CARD_HEIGHTS = [188, 132, 264, 156, 212, 144];

export function CardSkeleton({ height, delay = 0 }: { height: number; delay?: number }) {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 12px 8px" }}>
        <Bone width={24} height={24} radius={12} delay={delay} />
        <span style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1, minWidth: 0 }}>
          <Bone width="52%" height={9} delay={delay + 60} />
          <Bone width="34%" height={8} delay={delay + 90} />
        </span>
      </div>
      <div style={{ padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        <Bone height={8} delay={delay + 120} />
        <Bone width="88%" height={8} delay={delay + 150} />
      </div>
      <Bone height={height} radius={0} delay={delay + 180} style={{ borderTop: "1px solid var(--line)" }} />
    </div>
  );
}

/**
 * A masonry-shaped wall of cards, in the column count the grid itself uses.
 *
 * The container ref is the real grid's.
 *
 * Column count is measured from the element that holds the cards, and while
 * the skeleton is up that element is this one — without the ref the measure
 * never runs and a four-column grid loads as one long column.
 */
export function GridSkeleton({
  columns = 4,
  count = 12,
  containerRef,
}: {
  columns?: number;
  count?: number;
  containerRef?: (element: HTMLDivElement | null) => void;
}) {
  const buckets: number[][] = Array.from({ length: columns }, () => []);
  for (let index = 0; index < count; index++) {
    (buckets[index % columns] as number[]).push(index);
  }

  return (
    <Loading label="Loading your library">
      <div ref={containerRef} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        {buckets.map((bucket, column) => (
          <div
            key={column}
            style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}
          >
            {bucket.map((index) => (
              <CardSkeleton
                key={index}
                height={CARD_HEIGHTS[index % CARD_HEIGHTS.length] as number}
                delay={index * 40}
              />
            ))}
          </div>
        ))}
      </div>
    </Loading>
  );
}

export function RowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <Loading label="Loading your library">
      <div style={{ display: "flex", flexDirection: "column" }}>
        {Array.from({ length: count }, (_, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 13,
              padding: "12px 8px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <Bone width={64} height={64} radius={6} delay={index * 50} />
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
              <Bone width="30%" height={9} delay={index * 50 + 60} />
              <Bone height={8} delay={index * 50 + 90} />
              <Bone width="72%" height={8} delay={index * 50 + 120} />
            </span>
          </div>
        ))}
      </div>
    </Loading>
  );
}

/* ------------------------------------------------------------- lists --- */

export function CreatorRowsSkeleton({ count = 10 }: { count?: number }) {
  return (
    <Loading label="Loading creators">
      <div>
        {Array.from({ length: count }, (_, index) => (
          <div
            key={index}
            style={{
              display: "grid",
              gridTemplateColumns: "34px 1fr 320px 92px",
              gap: 16,
              alignItems: "center",
              padding: "11px 8px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <Bone width={16} height={9} delay={index * 45} />
            <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <Bone width={24} height={24} radius={12} delay={index * 45 + 30} />
              <Bone width="42%" height={9} delay={index * 45 + 60} />
            </span>
            {/* Descending, so the shape reads as a ranking before it is one. */}
            <Bone height={6} width={`${Math.max(96 - index * 9, 12)}%`} radius={3} delay={index * 45 + 90} />
            <Bone width={28} height={9} delay={index * 45 + 120} style={{ marginLeft: "auto" }} />
          </div>
        ))}
      </div>
    </Loading>
  );
}

export function SourceCardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <Loading label="Loading sources">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: 14,
        }}
      >
        {Array.from({ length: count }, (_, index) => (
          <div
            key={index}
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Bone width={30} height={30} radius={7} delay={index * 70} />
              <span style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
                <Bone width="46%" height={10} delay={index * 70 + 40} />
                <Bone width="62%" height={8} delay={index * 70 + 70} />
              </span>
              <Bone width={36} height={20} radius={10} delay={index * 70 + 100} />
            </div>
            <Bone height={6} radius={3} delay={index * 70 + 130} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 18 }}>
              {[0, 1, 2, 3].map((cell) => (
                <span key={cell} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <Bone width="40%" height={11} delay={index * 70 + 160 + cell * 25} />
                  <Bone width="60%" height={7} delay={index * 70 + 180 + cell * 25} />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Loading>
  );
}

/* ------------------------------------------------------------ counts --- */

/**
 * A number that has not arrived.
 *
 * Sized to the digits it will hold rather than to the text it replaces, so the
 * line does not reflow when the real figure lands.
 */
export function CountBone({ digits = 4, height = 10 }: { digits?: number; height?: number }) {
  return <Bone width={digits * 7} height={height} radius={3} style={{ display: "inline-block" }} />;
}
