import { compact, shortDate, type ItemRow } from "../lib/api.ts";
import { Avatar } from "./avatar.tsx";
import { SourceMark } from "./sourcemark.tsx";

const LANGUAGE_COLORS: Record<string, string> = {
  c: "#555555",
  "c#": "#178600",
  "c++": "#f34b7d",
  css: "#563d7c",
  dart: "#00b4ab",
  go: "#00add8",
  html: "#e34c26",
  java: "#b07219",
  javascript: "#f1e05a",
  kotlin: "#a97bff",
  lua: "#000080",
  php: "#4f5d95",
  python: "#3572a5",
  ruby: "#701516",
  rust: "#dea584",
  shell: "#89e051",
  swift: "#f05138",
  typescript: "#3178c6",
  vue: "#41b883",
};

const NEUTRAL_LANGUAGE_COLOR = "#c8d0da";

export function githubLanguageColor(language?: string | null): string {
  return LANGUAGE_COLORS[language?.trim().toLowerCase() ?? ""] ?? NEUTRAL_LANGUAGE_COLOR;
}

function repoName(item: ItemRow): { owner: string; name: string } {
  const title = item.title?.trim() ?? "";
  const separator = title.lastIndexOf("/");
  if (separator > 0 && separator < title.length - 1) {
    return { owner: title.slice(0, separator), name: title.slice(separator + 1) };
  }

  return {
    owner: item.authorName ?? item.author ?? "GitHub",
    name: title || "Repository",
  };
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  if (value == null) return null;

  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 44 }}>
      <span style={{ color: "#4b5563", fontSize: 11, lineHeight: 1.1 }}>{compact(value)}</span>
      <span style={{ color: "#7b8490", fontSize: 8.5, lineHeight: 1.1 }}>{label}</span>
    </span>
  );
}

/** The GitHub-specific interior of the shared Anansi card shell. */
export function GithubRepoCard({ item }: { item: ItemRow }) {
  const { owner, name } = repoName(item);
  const fullName = item.title?.trim() || `${owner}/${name}`;
  const metrics = item.metrics ?? {};
  const language = item.language?.trim() || null;
  const languageColor = githubLanguageColor(language);

  return (
    <>
      <div style={{ padding: "12px 12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Avatar src={item.authorAvatar} seed={owner} square size={22} />
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{owner}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>github repository</span>
          </span>
        </div>

        <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fullName}
        </div>

        {item.excerpt.trim() && (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--muted)",
              display: "-webkit-box",
              WebkitLineClamp: 5,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {item.excerpt}
          </div>
        )}
      </div>

      <div
        style={{
          margin: "12px 12px 0",
          borderRadius: 10,
          overflow: "hidden",
          background: "#fff",
          color: "#24292f",
          border: "1px solid #d8dee4",
          boxShadow: "0 1px 2px #00000012",
        }}
      >
        <div style={{ padding: 14, minHeight: 116, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <Avatar src={item.authorAvatar} seed={owner} square size={32} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ color: "#57606a", fontSize: 12.5, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{owner}/</div>
              <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              <div className="mono" style={{ color: "#6e7781", fontSize: 9.5, marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                github.com/{owner}/{name}
              </div>
            </div>
            <SourceMark source="github" size={16} />
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginTop: "auto", minHeight: 25 }}>
            <Stat label="Issues" value={metrics.openIssues} />
            <Stat label="Stars" value={metrics.stars} />
            <Stat label="Forks" value={metrics.forks} />
            <Stat label="Watchers" value={metrics.watchers} />
          </div>
        </div>
        <div title={language ?? "Language unavailable"} style={{ height: 5, background: language ? languageColor : "#e5e7eb" }} />
      </div>

      <div style={{ padding: "10px 12px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        {item.platformSaved === 0 && (
          <span
            title={item.removedFromSourceAt ? `No longer saved on GitHub, since ${new Date(item.removedFromSourceAt * 1000).toLocaleDateString()}` : "No longer saved on GitHub"}
            style={{ color: "var(--fainter)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 6px", fontSize: 10 }}
          >
            unsaved
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{shortDate(item.postedAt)}</span>
          <SourceMark source="github" size={12} />
        </span>
      </div>
    </>
  );
}
