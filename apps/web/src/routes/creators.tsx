import { Button } from "@anansi/ui/components/button";
import { Input } from "@anansi/ui/components/input";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/avatar.tsx";
import { FieldFilter } from "../components/filters.tsx";
import { Rail } from "../components/rail.tsx";
import { Bone, CountBone, useSlowLoad } from "../components/skeleton.tsx";
import { SourceMark } from "../components/sourcemark.tsx";
import { api, type Creator, LIBRARY_SOURCES, sourceLabel } from "../lib/api.ts";
import { authorHandleLine } from "../lib/author-handle.ts";
import { useCreatorsQuery } from "../lib/creators-query.ts";
import { libraryKeys } from "../lib/library-query.ts";

/** The same source vocabulary the library uses. */
const PLATFORMS = LIBRARY_SOURCES.map((value) => ({ value, label: sourceLabel(value) }));

export const Route = createFileRoute("/creators")({ component: Creators });

/**
 * Authors, browsed.
 *
 * The page answers "whose things do I keep saving?", so a tile carries who
 * they are, where they post, and how many of their things you kept. Library
 * totals and distribution statistics live on the library; repeating them here
 * only pushed the authors down.
 */
function Creators() {
	const [filter, setFilter] = useState("");
	const [platforms, setPlatforms] = useState<string[]>([]);
	const statsQuery = useQuery({
		queryKey: libraryKeys.stats(),
		queryFn: ({ signal }) => api.stats(signal),
		retry: 1,
		staleTime: 15_000,
	});
	const creatorQuery = useCreatorsQuery(filter, platforms);
	const creators = creatorQuery.creators;
	const stats = statsQuery.data;
	const bySource = stats?.bySource ?? {};
	const firstLoad = creatorQuery.isPending;
	const slow = useSlowLoad(firstLoad || statsQuery.isPending);
	const narrowed = platforms.length > 0 || filter.trim() !== "";
	const total = creatorQuery.total;
	const sentinel = useRef<HTMLDivElement>(null);

	const sourceOptions = PLATFORMS.filter((platform) => (bySource[platform.value] ?? 0) > 0).map(
		(platform) => ({
			...platform,
			icon: <SourceMark source={platform.value} size={14} />,
		}),
	);

	useEffect(() => {
		const node = sentinel.current;
		if (!node) return;
		const io = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting && creatorQuery.hasNextPage && !creatorQuery.isFetchingNextPage)
				void creatorQuery.fetchNextPage();
		});
		io.observe(node);
		return () => io.disconnect();
	}, [creatorQuery.fetchNextPage, creatorQuery.hasNextPage, creatorQuery.isFetchingNextPage]);

	return (
		<div className="anansi-shell" style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
			<Rail
				total={stats?.items ?? 0}
				authors={stats?.authors ?? 0}
				archived={stats?.archived ?? 0}
				bySource={bySource}
			/>

			<div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
				<header className="authors-header">
					<div className="authors-title">
						<h1>Authors</h1>
						{stats ? (
							<span className="authors-count">{stats.authors.toLocaleString()}</span>
						) : (
							slow && <CountBone digits={4} height={10} />
						)}
					</div>
					<div className="authors-tools">
						{sourceOptions.length > 0 && (
							<FieldFilter
								label="Source"
								values={platforms}
								onChange={setPlatforms}
								options={sourceOptions}
							/>
						)}
						{narrowed && !firstLoad && (
							<span className="authors-matches" aria-live="polite">
								{total.toLocaleString()} {total === 1 ? "match" : "matches"}
							</span>
						)}
						<Input
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder="Filter authors"
							aria-label="Filter authors"
							className="authors-search"
						/>
					</div>
				</header>

				<div className="scroll" style={{ flex: 1 }}>
					<div className="anansi-creator-grid" aria-busy={creatorQuery.isFetching || undefined}>
						{creatorQuery.isError ? (
							<div role="alert" className="authors-empty">
								Authors are unavailable right now.
								<Button variant="outline" size="sm" onClick={() => void creatorQuery.refetch()}>
									Retry
								</Button>
							</div>
						) : firstLoad ? (
							slow && <AuthorTileSkeletons />
						) : creators.length === 0 ? (
							<div className="authors-empty">
								{narrowed ? "No authors match this filter" : "No authors yet"}
							</div>
						) : (
							creators.map((creator) =>
								creator.authorHandle ? (
									<AuthorTile key={`${creator.source}:${creator.authorHandle}`} creator={creator} />
								) : null,
							)
						)}
						{creatorQuery.isFetchingNextPage && <AuthorTileSkeletons count={3} />}
					</div>
					<div ref={sentinel} style={{ height: 1 }} aria-hidden="true" />
				</div>
			</div>
		</div>
	);
}

function AuthorTile({ creator }: { creator: Creator }) {
	const handle = creator.authorHandle ?? "";
	const name = creator.authorName ?? handle;
	const handleLine = authorHandleLine(creator);
	return (
		<a
			href={`/?author=${encodeURIComponent(handle)}`}
			className="author-tile"
			aria-label={`${name}, ${creator.saves} ${creator.saves === 1 ? "save" : "saves"}. Open in the library`}
		>
			<Avatar src={creator.authorAvatar} seed={handle || creator.authorName} name={name} size={40} />
			<span className="author-tile-who">
				<span className="author-tile-name">
					<strong>{name}</strong>
					<SourceMark source={creator.source} size={14} />
				</span>
				{handleLine && <span className="author-tile-handle">{handleLine}</span>}
			</span>
			<span className="author-tile-saves">{creator.saves.toLocaleString()}</span>
		</a>
	);
}

function AuthorTileSkeletons({ count = 12 }: { count?: number }) {
	return (
		<>
			{Array.from({ length: count }, (_, index) => (
				<div key={index} className="author-tile" aria-hidden="true">
					<Bone width={40} height={40} radius={20} delay={index * 40} />
					<span className="author-tile-who" style={{ gap: 8 }}>
						<Bone width="55%" height={12} delay={index * 40} />
						<Bone width="35%" height={10} delay={index * 40} />
					</span>
				</div>
			))}
		</>
	);
}
