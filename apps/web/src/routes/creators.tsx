import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "../components/avatar.tsx";
import { Bone, CountBone, CreatorRowsSkeleton, useSlowLoad } from "../components/skeleton.tsx";
import { FieldFilter } from "../components/filters.tsx";
import { Rail } from "../components/rail.tsx";
import { SourceMark } from "../components/sourcemark.tsx";
import { api, sourceLabel, type Creator } from "../lib/api.ts";

/** The same source vocabulary the library uses. */
const PLATFORMS = [
	{ value: "x", label: sourceLabel("x") },
	{ value: "github", label: sourceLabel("github") },
	{ value: "reddit", label: sourceLabel("reddit") },
	{ value: "web", label: sourceLabel("web") },
];

export const Route = createFileRoute("/creators")({ component: Creators });

/** Keep the denominator explicit: an author's share is of the whole library. */
export function authorSharePercent(saves: number, libraryItems: number): number {
	if (libraryItems <= 0 || saves <= 0) return 0;
	return (saves / libraryItems) * 100;
}

export function formatAuthorShare(saves: number, libraryItems: number): string {
	const percent = authorSharePercent(saves, libraryItems);
	return percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

function Creators() {
	const [creators, setCreators] = useState<Creator[]>([]);
	const [stats, setStats] = useState<{ items: number; authors: number; archived: number; bySource: Record<string, number> }>({ items: 0, authors: 0, archived: 0, bySource: {} });
	const [filter, setFilter] = useState("");
	const [platforms, setPlatforms] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const controller = new AbortController();
		Promise.all([api.stats(controller.signal), api.creators(1000, controller.signal)])
			.then(([s, c]) => {
				setStats({ items: s.items, authors: s.authors, archived: s.archived, bySource: s.bySource });
				setCreators(c.creators);
			})
			.catch(() => {})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, []);

	const shown = useMemo(() => {
		const query = filter.trim().toLowerCase();
		return creators.filter((creator) => {
			if (platforms.length > 0 && !platforms.includes(creator.source)) return false;
			if (!query) return true;
			return (creator.authorHandle ?? "").toLowerCase().includes(query) || (creator.authorName ?? "").toLowerCase().includes(query);
		});
	}, [creators, filter, platforms]);

	const slow = useSlowLoad(loading);
	const once = creators.filter((creator) => creator.saves === 1).length;
	const topTenShare = stats.items
		? Math.round((creators.slice(0, 10).reduce((total, creator) => total + creator.saves, 0) / stats.items) * 100)
		: 0;
	const perAuthor = stats.authors ? (stats.items / stats.authors).toFixed(2) : "0";

	return (
		<div className="anansi-shell" style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
			<Rail total={stats.items} authors={stats.authors} archived={stats.archived} bySource={stats.bySource} />

			<div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
				<header
					style={{
						minHeight: 52,
						flexShrink: 0,
						borderBottom: "1px solid var(--line)",
						display: "flex",
						alignItems: "center",
						gap: 14,
						padding: "10px 22px",
						flexWrap: "wrap",
					}}
				>
					<span style={{ fontSize: 14, fontWeight: 600 }}>Authors</span>
					<span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
						{loading ? slow ? <><CountBone digits={3} height={8} /> authors · <CountBone digits={5} height={8} /> saved items</> : null : `${stats.authors} authors · ${stats.items.toLocaleString()} saved items`}
					</span>
					<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
						<FieldFilter
							label="Source"
							values={platforms}
							onChange={setPlatforms}
							options={PLATFORMS.filter((platform) => (stats.bySource[platform.value] ?? 0) > 0).map((platform) => ({
								...platform,
								count: creators.filter((creator) => creator.source === platform.value).length,
								icon: <SourceMark source={platform.value} size={13} />,
							}))}
						/>
						{(platforms.length > 0 || filter.trim() !== "") && (
							<span className="mono" style={{ fontSize: 10.5, color: "var(--faintest)" }}>
								{shown.length.toLocaleString()} of {creators.length.toLocaleString()}
							</span>
						)}
					</span>
					<input
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
						placeholder="Filter authors"
						aria-label="Filter authors"
						style={{
							height: 30,
							width: 210,
							maxWidth: "100%",
							padding: "0 10px",
							border: "1px solid var(--edge)",
							borderRadius: 5,
							background: "var(--card)",
							color: "var(--text)",
							fontSize: 12.5,
							fontFamily: "var(--sans)",
							outline: "none",
						}}
					/>
				</header>

				<div style={{ flexShrink: 0, borderBottom: "1px solid var(--line)", padding: "16px 22px", display: "flex", gap: 44, flexWrap: "wrap" }}>
					<Stat n={String(stats.authors)} label="authors" pending={loading && slow} />
					<Stat n={perAuthor} label="saved items per author" pending={loading && slow} />
					<Stat n={`${topTenShare}%`} label="of saved items from top 10" accent pending={loading && slow} />
					<Stat n={String(once)} label="saved exactly once" pending={loading && slow} />
				</div>

				<div className="scroll" style={{ flex: 1 }}>
					{loading && slow && <CreatorRowsSkeleton />}
					<div className="anansi-creator-grid" style={{ padding: "14px 22px 40px" }}>
						{!loading && shown.length === 0 ? (
							<div style={{ gridColumn: "1 / -1", padding: "42px 12px", textAlign: "center", color: "var(--faint)", fontSize: 12.5 }}>
								{creators.length === 0 ? "No authors yet" : "No authors match this filter"}
							</div>
						) : shown.map((creator) => {
							if (!creator.authorHandle) return null;
							const share = authorSharePercent(creator.saves, stats.items);
							return (
								<a
									key={`${creator.source}:${creator.authorHandle}`}
									href={`/?author=${encodeURIComponent(creator.authorHandle)}`}
									aria-label={`Open ${creator.authorName ?? creator.authorHandle} in the library`}
									style={{
										display: "flex",
										alignItems: "center",
										gap: 11,
										minWidth: 0,
										minHeight: 68,
										padding: "11px 12px",
										border: "1px solid var(--line)",
										borderRadius: 8,
										background: "var(--card)",
										color: "inherit",
										textDecoration: "none",
										boxShadow: "0 6px 16px -12px #000",
									}}
								>
										<Avatar src={creator.authorAvatar} seed={creator.authorHandle ?? creator.authorName} size={42} />
									<span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
										<span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
											<strong style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{creator.authorName ?? creator.authorHandle}</strong>
											<SourceMark source={creator.source} size={12} />
										</span>
										<span className="mono" style={{ fontSize: 10.5, color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>@{creator.authorHandle}</span>
									</span>
									<span className="mono" style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0, color: "var(--muted)" }}>
										<span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, fontSize: 10.5 }}>
											<strong style={{ fontSize: 13, color: "var(--text)" }}>{creator.saves}</strong>
										</span>
										<ShareDonut percent={share} label={formatAuthorShare(creator.saves, stats.items)} />
									</span>
								</a>
							);
						})}
					</div>

					<div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 30px 40px", fontSize: 11, color: "var(--fainter)" }}>
						{loading ? slow ? <><CountBone digits={3} height={8} /> of <CountBone digits={3} height={8} /> saved exactly once</> : null : `${once} of ${stats.authors} saved exactly once`}
						<span style={{ flex: 1, height: 1, background: "var(--line-soft)" }} />
					</div>
				</div>
			</div>
		</div>
	);
}

	function Stat({ n, label, accent, pending }: { n: string; label: string; accent?: boolean; pending?: boolean }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
			{pending ? <Bone width={44} height={17} radius={4} style={{ marginBottom: 3 }} /> : <span className="mono" style={{ fontSize: 20, color: accent ? "var(--accent)" : "var(--text)" }}>{n}</span>}
			<span style={{ fontSize: 11.5, color: "var(--faint)" }}>{label}</span>
		</div>
	);
	}

function ShareDonut({ percent, label }: { percent: number; label: string }) {
	const radius = 15;
	const circumference = 2 * Math.PI * radius;
	const dash = (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	return (
		<span
			role="img"
			aria-label={`${label} of library saved items`}
			title={`${label} of library saved items`}
			style={{ width: 36, height: 36, position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
		>
			<svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" style={{ transform: "rotate(-90deg)" }}>
				<circle cx="18" cy="18" r={radius} fill="none" stroke="var(--edge)" strokeWidth="4" />
				<circle cx="18" cy="18" r={radius} fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${dash} ${circumference - dash}`} />
			</svg>
			<span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 8.5, color: "var(--text-dim)" }}>{percent < 0.1 && percent > 0 ? "<.1" : `${Math.round(percent)}%`}</span>
		</span>
	);
}
