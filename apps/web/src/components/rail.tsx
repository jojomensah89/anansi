import { Link, useRouterState } from "@tanstack/react-router";

/**
 * The 228px rail from the Library artboard.
 *
 * Counts are passed in rather than fetched here: two components fetching the
 * same numbers is how a sidebar ends up disagreeing with the page beside it.
 */
export interface RailProps {
  total: number;
  authors: number;
  archived?: number;
  bySource: Record<string, number>;
}

function Web() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 8.8V3M12 15.2V21M8.8 12H3M15.2 12H21M9.7 9.7 5.6 5.6M14.3 9.7l4.1-4.1M9.7 14.3l-4.1 4.1M14.3 14.3l4.1 4.1" />
    </svg>
  );
}

function Item({
  to, label, count, active, children,
}: {
  to: string; label: string; count?: string; active: boolean; children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "7px 8px",
        borderRadius: 5, fontSize: 13,
        background: active ? "var(--raised)" : "transparent",
        color: active ? "var(--text)" : "var(--muted)",
        fontWeight: active ? 500 : 400,
      }}
    >
      {children}
      {label}
      {count !== undefined && (
        <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: active ? "var(--faint)" : "var(--fainter)" }}>
          {count}
        </span>
      )}
    </Link>
  );
}

export function Rail({ total, authors, archived = 0, bySource }: RailProps) {
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div style={{
      width: 228, flexShrink: 0, background: "var(--rail)",
      borderRight: "1px solid var(--line)", display: "flex",
      flexDirection: "column", padding: "16px 0",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 16px 18px" }}>
        <Web />
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em" }}>Anansi</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px" }}>
        <Item to="/" label="Library" count={String(total)} active={path === "/"}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={path === "/" ? "var(--accent)" : "var(--faint)"} strokeWidth="1.6" strokeLinejoin="round">
            <path d="M6 4h12v17l-6-4-6 4z" />
          </svg>
        </Item>
        <Item to="/creators" label="Creators" count={String(authors)} active={path === "/creators"}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={path === "/creators" ? "var(--accent)" : "var(--faint)"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 6.2a3 3 0 0 1 0 5.6M17.5 19c0-2-.6-3.6-1.7-4.6" />
          </svg>
        </Item>
        <Item to="/sources" label="Sources" active={path === "/sources"}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={path === "/sources" ? "var(--accent)" : "var(--faint)"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M4 12h16M4 17h9" />
          </svg>
        </Item>
      </div>

      <div className="mono" style={{ padding: "22px 16px 8px", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--fainter)" }}>
        Sources
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px" }}>
        {(
          [
            ["x", "Bookmarks", bySource.x ?? 0],
            ["gh", "Stars", bySource.github ?? 0],
            ["r/", "Reddit", bySource.reddit ?? 0],
            ["tt", "TikTok", bySource.tiktok ?? 0],
          ] as const
        ).map(([tag, label, n]) => (
          <div key={tag} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: 5, fontSize: 12.5, color: "var(--text-dim)" }}>
            <span className="mono" style={{ fontSize: 10, width: 22, height: 16, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--edge-strong)", borderRadius: 3, color: "var(--muted)" }}>
              {tag}
            </span>
            {label}
            <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>{n}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: "auto", padding: "12px 16px 0", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 5 }}>
        <div className="mono" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 10.5, color: "var(--faint)" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />
          local library
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--faintest)" }}>
          {total.toLocaleString()} items · {authors} authors
        </div>
      </div>
    </div>
  );
}
