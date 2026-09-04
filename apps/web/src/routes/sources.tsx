import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { SourceCardsSkeleton, useSlowLoad } from "../components/skeleton.tsx";
import { SourceMark } from "../components/sourcemark.tsx";
import {
	api,
	type ExtensionHealth,
	type SourceRow,
	type SourcesResponse,
} from "../lib/api.ts";
import { useHideRemoved } from "../lib/settings.ts";
import {
	extensionLabel,
	type SourceTone,
	sourcePresentation,
} from "../lib/source-state.ts";

export const Route = createFileRoute("/sources")({ component: Sources });

type Tab = "all" | "active" | "coming_next";

const TONE: Record<
	SourceTone,
	{ text: string; dot: string; border: string; background: string }
> = {
	ok: {
		text: "var(--ok)",
		dot: "var(--ok)",
		border: "#2d4a3d",
		background: "#17231f",
	},
	accent: {
		text: "var(--accent-text)",
		dot: "var(--accent)",
		border: "#4a3c22",
		background: "var(--accent-soft)",
	},
	warn: {
		text: "#e7b86b",
		dot: "#d99b43",
		border: "#554020",
		background: "#261f14",
	},
	muted: {
		text: "var(--muted)",
		dot: "var(--muted)",
		border: "var(--edge)",
		background: "var(--raised)",
	},
	faint: {
		text: "var(--faint)",
		dot: "var(--faint)",
		border: "var(--edge)",
		background: "transparent",
	},
};

function ago(unix: number | null): string {
	if (!unix) return "never";
	const minutes = Math.max(0, Math.round((Date.now() - unix * 1000) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function Sources() {
	const [data, setData] = useState<SourcesResponse | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [tab, setTab] = useState<Tab>("all");
	const [hideRemoved, setHideRemoved] = useHideRemoved();
	const [stats, setStats] = useState({
		items: 0,
		authors: 0,
		bySource: {} as Record<string, number>,
	});

	useEffect(() => {
		const controller = new AbortController();
		Promise.all([api.stats(controller.signal), api.sources(controller.signal)])
			.then(([nextStats, nextSources]) => {
				setStats({
					items: nextStats.items,
					authors: nextStats.authors,
					bySource: nextStats.bySource,
				});
				setData(nextSources);
				setLoadFailed(false);
			})
			.catch((error: unknown) => {
				if ((error as { name?: string }).name !== "AbortError")
					setLoadFailed(true);
			});
		return () => controller.abort();
	}, []);

	const visible = useMemo(() => {
		if (!data) return [];
		if (tab === "coming_next")
			return data.sources.filter((source) => source.support === "coming_next");
		if (tab === "active")
			return data.sources.filter((source) => source.support !== "coming_next");
		return data.sources;
	}, [data, tab]);

	const toggle = (source: string, enabled: boolean) => {
		setData(
			(previous) =>
				previous && {
					...previous,
					sources: previous.sources.map((row) =>
						row.source === source ? { ...row, enabled } : row,
					),
				},
		);
		api.toggleSource(source, enabled).catch(() => {
			setData(
				(previous) =>
					previous && {
						...previous,
						sources: previous.sources.map((row) =>
							row.source === source ? { ...row, enabled: !enabled } : row,
						),
					},
			);
		});
	};

	const slow = useSlowLoad(data === null && !loadFailed);

	return (
		<div style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
			<Rail
				total={stats.items}
				authors={stats.authors}
				bySource={stats.bySource}
			/>

			<main
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					minWidth: 0,
				}}
			>
				<header
					style={{
						height: 52,
						flexShrink: 0,
						borderBottom: "1px solid var(--line)",
						display: "flex",
						alignItems: "center",
						gap: 14,
						padding: "0 22px",
					}}
				>
					<span style={{ fontSize: 14, fontWeight: 600 }}>Sources</span>
					<span
						className="mono"
						style={{ fontSize: 11, color: "var(--faint)" }}
					>
						capture status reported by your extension
					</span>
					<Tabs value={tab} onChange={setTab} />
				</header>

				<div className="scroll" style={{ flex: 1, padding: "18px 22px 60px" }}>
					{data && <ExtensionBanner extension={data.extension} />}
					{!data && !loadFailed && slow && <SourceCardsSkeleton />}
					{loadFailed && (
						<Notice>
							Source status could not be loaded. The library is still available,
							but Anansi cannot confirm extension health right now.
						</Notice>
					)}

					{data && (
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
								gap: 14,
							}}
						>
							{visible.map((source) => (
								<SourceCard
									key={source.source}
									row={source}
									extension={data.extension}
									onToggle={toggle}
								/>
							))}
						</div>
					)}

					<LibraryPreference
						hideRemoved={hideRemoved}
						onToggle={() => setHideRemoved(!hideRemoved)}
					/>
				</div>
			</main>
		</div>
	);
}

function Tabs({
	value,
	onChange,
}: {
	value: Tab;
	onChange: (tab: Tab) => void;
}) {
	return (
		<div
			style={{
				marginLeft: "auto",
				display: "flex",
				gap: 2,
				padding: 2,
				background: "var(--card)",
				border: "1px solid var(--edge)",
				borderRadius: 6,
			}}
		>
			{(
				[
					["all", "All"],
					["active", "Active"],
					["coming_next", "Coming next"],
				] as const
			).map(([next, label]) => (
				<button
					key={next}
					type="button"
					onClick={() => onChange(next)}
					aria-pressed={value === next}
					style={{
						height: 24,
						padding: "0 11px",
						borderRadius: 4,
						border: "none",
						background: value === next ? "var(--raised)" : "transparent",
						color: value === next ? "var(--text)" : "var(--muted)",
						fontSize: 11.5,
						cursor: "pointer",
						font: "inherit",
					}}
				>
					{label}
				</button>
			))}
		</div>
	);
}

function ExtensionBanner({ extension }: { extension: ExtensionHealth }) {
	const connected = extension.connection === "connected";
	const neverConnected = extension.connection === "never_connected";
	const queued =
		extension.queue.queued +
		extension.queue.uploading +
		extension.queue.retrying;
	const tone = connected ? TONE.ok : TONE.warn;

	return (
		<section
			style={{
				display: "flex",
				alignItems: "center",
				gap: 13,
				background: "var(--card)",
				border: `1px solid ${tone.border}`,
				borderRadius: 8,
				padding: "13px 16px",
				marginBottom: 16,
			}}
		>
			<span
				style={{
					width: 32,
					height: 32,
					borderRadius: 8,
					background: tone.background,
					border: `1px solid ${tone.border}`,
					color: tone.text,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<ExtensionIcon />
			</span>
			<span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 7,
						fontSize: 13.5,
						fontWeight: 600,
					}}
				>
					Anansi extension
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: tone.dot,
						}}
					/>
				</span>
				<span className="mono" style={{ fontSize: 10.5, color: tone.text }}>
					{extensionLabel(extension)}
					{!connected && !neverConnected && extension.lastSeenAt
						? ` · last seen ${ago(extension.lastSeenAt)}`
						: ""}
				</span>
			</span>
			<span
				className="mono"
				style={{
					marginLeft: "auto",
					fontSize: 10.5,
					color: "var(--faint)",
					textAlign: "right",
				}}
			>
				{connected
					? `${extension.activeClients} active ${extension.activeClients === 1 ? "browser" : "browsers"}${queued ? ` · ${queued} waiting` : " · queue clear"}`
					: neverConnected
						? "Open the extension once to begin reporting"
						: "Open the browser to resume capture"}
				{extension.queue.failed > 0 && (
					<span style={{ display: "block", color: TONE.warn.text }}>
						{extension.queue.failed.toLocaleString()} failed
					</span>
				)}
			</span>
		</section>
	);
}

function SourceCard({
	row,
	extension,
	onToggle,
}: {
	row: SourceRow;
	extension: ExtensionHealth;
	onToggle: (source: string, enabled: boolean) => void;
}) {
	const status = sourcePresentation(row, extension);
	const tone = TONE[status.tone];
	const manual = row.toolbar + row.contextMenu;

	return (
		<article
			style={{
				background: "var(--card)",
				border: `1px solid ${status.tone === "warn" ? tone.border : "var(--line)"}`,
				borderRadius: 8,
				display: "flex",
				flexDirection: "column",
				minHeight: 286,
				opacity: status.state === "disabled" ? 0.68 : 1,
			}}
		>
			<div style={{ padding: "16px 16px 0", flex: 1 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<SourceBadge source={row.source} />
					<span
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 1,
							minWidth: 0,
						}}
					>
						<span style={{ fontSize: 13.5, fontWeight: 600 }}>{row.name}</span>
						<span
							className="mono"
							style={{ fontSize: 10.5, color: "var(--faint)" }}
						>
							{row.host}
						</span>
					</span>
					<span style={{ marginLeft: "auto" }}>
						{row.toggleable ? (
							<Toggle
								checked={row.enabled}
								label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`}
								onClick={() => onToggle(row.source, !row.enabled)}
							/>
						) : (
							<ModeBadge mode={row.mode} />
						)}
					</span>
				</div>

				<p
					style={{
						margin: "12px 0 0",
						minHeight: 37,
						fontSize: 12,
						color: "var(--muted)",
						lineHeight: 1.55,
					}}
				>
					{row.note}
				</p>
				<Status text={status.text} tone={status.tone} />

				<div style={{ marginTop: 14 }}>
					<div
						className="mono"
						style={{
							marginBottom: 8,
							fontSize: 9.5,
							letterSpacing: "0.08em",
							textTransform: "uppercase",
							color: "var(--fainter)",
						}}
					>
						Stored capture provenance
					</div>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
							gap: "9px 10px",
						}}
					>
						<Fact label="live" value={row.live} />
						<Fact label="imported" value={row.imported} />
						<Fact label="manual" value={manual} />
						<Fact label="Chrome" value={row.chromeBookmarks} />
						<Fact label="legacy" value={row.legacyUnknown} />
						<Fact label="authors" value={row.authors} />
					</div>
				</div>

				{row.items === 0 && row.support !== "coming_next" && (
					<p
						className="mono"
						style={{
							margin: "13px 0 0",
							fontSize: 10.5,
							lineHeight: 1.5,
							color: "var(--faint)",
						}}
					>
						No items from this source have been stored yet.
					</p>
				)}
			</div>

			<footer
				style={{
					display: "flex",
					alignItems: "center",
					gap: 10,
					minHeight: 39,
					padding: "9px 16px",
					marginTop: 14,
					borderTop: "1px solid var(--line)",
				}}
			>
				<span
					className="mono"
					style={{ fontSize: 10.5, color: "var(--faint)" }}
				>
					last capture {ago(row.lastCaptureAt)}
				</span>
				{row.items > 0 && (
					<Link
						to="/"
						search={{ source: [row.source] }}
						style={{
							marginLeft: "auto",
							fontSize: 11.5,
							color: "var(--accent-text)",
						}}
					>
						View {row.items.toLocaleString()}
					</Link>
				)}
				{row.toggleable && <ModeBadge mode={row.mode} push={row.items === 0} />}
			</footer>
		</article>
	);
}

function Status({ text, tone: toneName }: { text: string; tone: SourceTone }) {
	const tone = TONE[toneName];
	return (
		<div
			className="mono"
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 7,
				marginTop: 12,
				padding: "4px 8px",
				borderRadius: 4,
				border: `1px solid ${tone.border}`,
				background: tone.background,
				color: tone.text,
				fontSize: 10.5,
			}}
		>
			<span
				style={{
					width: 6,
					height: 6,
					borderRadius: "50%",
					background: tone.dot,
				}}
			/>
			{text}
		</div>
	);
}

function Fact({ label, value }: { label: string; value: number }) {
	return (
		<span
			style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}
		>
			<span
				className="mono"
				style={{ fontSize: 13, color: value ? "var(--text)" : "var(--faint)" }}
			>
				{value.toLocaleString()}
			</span>
			<span style={{ fontSize: 10, color: "var(--faint)" }}>{label}</span>
		</span>
	);
}

function SourceBadge({ source }: { source: string }) {
	return (
		<span
			style={{
				width: 32,
				height: 32,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				borderRadius: 8,
				border: "1px solid var(--edge-strong)",
				background: "var(--raised)",
				flexShrink: 0,
			}}
		>
			<SourceMark source={source} size={17} />
		</span>
	);
}

function ModeBadge({
	mode,
	push,
}: {
	mode: SourceRow["mode"];
	push?: boolean;
}) {
	return (
		<span
			className="mono"
			style={{
				marginLeft: push ? "auto" : undefined,
				fontSize: 9.5,
				padding: "2px 6px",
				borderRadius: 3,
				border: "1px solid var(--edge)",
				color: mode === "observe" ? "var(--accent)" : "var(--faint)",
			}}
		>
			{mode}
		</span>
	);
}

function Toggle({
	checked,
	label,
	onClick,
}: {
	checked: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			role="switch"
			aria-checked={checked}
			aria-label={label}
			style={{
				width: 36,
				height: 20,
				borderRadius: 10,
				padding: "0 2px",
				display: "flex",
				alignItems: "center",
				justifyContent: checked ? "flex-end" : "flex-start",
				background: checked ? "#2a3f36" : "var(--raised)",
				border: `1px solid ${checked ? "#3d6353" : "var(--edge)"}`,
				cursor: "pointer",
			}}
		>
			<span
				style={{
					width: 14,
					height: 14,
					borderRadius: "50%",
					background: checked ? "var(--ok)" : "var(--faint)",
				}}
			/>
		</button>
	);
}

function LibraryPreference({
	hideRemoved,
	onToggle,
}: {
	hideRemoved: boolean;
	onToggle: () => void;
}) {
	return (
		<section
			style={{
				marginTop: 24,
				padding: "13px 16px",
				background: "var(--card)",
				border: "1px solid var(--line)",
				borderRadius: 8,
				display: "flex",
				alignItems: "center",
				gap: 14,
				maxWidth: 640,
			}}
		>
			<span
				style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}
			>
				<span style={{ fontSize: 13, fontWeight: 500 }}>
					Hide items removed at the source
				</span>
				<span
					style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.5 }}
				>
					Anansi keeps previously captured items. Turn this on when you want the
					library to mirror only what remains saved on each platform.
				</span>
			</span>
			<Toggle
				checked={hideRemoved}
				label="Hide items removed at the source"
				onClick={onToggle}
			/>
		</section>
	);
}

function Notice({ children }: { children: ReactNode }) {
	return (
		<div
			style={{
				maxWidth: 680,
				padding: "13px 16px",
				background: TONE.warn.background,
				border: `1px solid ${TONE.warn.border}`,
				borderRadius: 8,
				color: TONE.warn.text,
				fontSize: 12,
				lineHeight: 1.55,
			}}
		>
			{children}
		</div>
	);
}

function ExtensionIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M10 4a2 2 0 1 1 4 0v2h3a1 1 0 0 1 1 1v3h2a2 2 0 1 1 0 4h-2v3a1 1 0 0 1-1 1h-3v-2a2 2 0 1 0-4 0v2H7a1 1 0 0 1-1-1v-3H4a2 2 0 1 1 0-4h2V7a1 1 0 0 1 1-1h3z" />
		</svg>
	);
}
