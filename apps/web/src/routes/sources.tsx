import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { ExtensionIcon } from "../components/extension-icon.tsx";
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
	extensionStatus,
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
		border: "var(--ok-edge)",
		background: "var(--ok-soft)",
	},
	accent: {
		text: "var(--accent-text)",
		dot: "var(--accent)",
		border: "var(--edge-strong)",
		background: "var(--accent-soft)",
	},
	warn: {
		text: "var(--warn)",
		dot: "var(--warn)",
		border: "var(--warn-edge)",
		background: "var(--warn-soft)",
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

/** The banner is titled "Anansi extension", so its status drops the repeated noun. */
function bannerLabel(extension: ExtensionHealth): string {
	const label = extensionLabel(extension).replace(/^Extension /, "");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

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
		archived: 0,
		bySource: {} as Record<string, number>,
	});

	useEffect(() => {
		const controller = new AbortController();
		Promise.all([api.stats(controller.signal), api.sources(controller.signal)])
			.then(([nextStats, nextSources]) => {
				setStats({
					items: nextStats.items,
					authors: nextStats.authors,
					archived: nextStats.archived,
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
		<div className="anansi-shell" style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
			<Rail
				 total={stats.items}
				authors={stats.authors}
				archived={stats.archived}
				bySource={stats.bySource}
                ready={data!==null}
			/>

			<main
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					minWidth: 0,
				}}
			>

				<header className="sources-header"
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
					<h1 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Sources</h1>
					<Tabs value={tab} onChange={setTab} />
				</header>

				<div className="scroll" style={{ flex: 1, padding: "18px 22px 60px" }}>
					{data && <ExtensionBanner extension={data.extension} />}
					{!data && !loadFailed && slow && <SourceCardsSkeleton />}
					{loadFailed && (
						<Notice>
							Could not load source status. Your library is unaffected.
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
						fontSize: 12,
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
	const tone = TONE[extensionStatus(extension).tone];

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
				<span style={{ fontSize: 12, color: tone.text }}>
					{bannerLabel(extension)}
					{!connected && !neverConnected && extension.lastSeenAt
						? ` · last seen ${ago(extension.lastSeenAt)}`
						: ""}
				</span>
			</span>
			<span
				style={{
					marginLeft: "auto",
					fontSize: 12,
					color: "var(--muted)",
					textAlign: "right",
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{connected
					? `${extension.activeClients} ${extension.activeClients === 1 ? "browser" : "browsers"}${queued ? ` · ${queued} waiting` : ""}`
					: neverConnected
						? "Open the extension once to start"
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
 const check = extension.sources[row.source as keyof typeof extension.sources];

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
						<span style={{ fontSize: 12, color: "var(--muted)" }}>
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
						fontSize: 14,
						color: "var(--muted)",
						lineHeight: 1.55,
					}}
				>
					{row.note}
				</p>
				{/* The extension card above already reports a lost connection once. */}
				{status.state !== "disconnected" && <Status text={status.text} tone={status.tone} />}
				{row.source === "tiktok" && row.items === 0 && status.state === "failed" && (
					<p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--accent-text)" }}>
						Sign in to TikTok, then open the Anansi extension and press Import.
					</p>
				)}

				<div style={{ marginTop: 14 }}>
					<div style={{ marginBottom: 8, fontSize: 12, color: "var(--muted)" }}>
						How saves arrived
					</div>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
							gap: "9px 10px",
						}}
					>
						<Fact label="Live" value={row.live} />
						<Fact label="Imported" value={row.imported} />
						<Fact label="Manual" value={manual} />
						<Fact label="Chrome" value={row.chromeBookmarks} />
						<Fact label="Legacy" value={row.legacyUnknown} />
						<Fact label="Authors" value={row.authors} />
					</div>
				</div>

				{row.items === 0 && row.support !== "coming_next" && (
					<p style={{ margin: "13px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
						Nothing saved yet
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
				<span style={{ fontSize: 12, color: "var(--muted)" }}>
					Last capture {ago(row.lastCaptureAt)}
          {["x", "reddit", "github", "tiktok"].includes(row.source) && <>{" · "}{check?.lastCheckedAt ? `checked ${ago(check.lastCheckedAt)}` : "not checked yet"}{check?.lastErrorCode ? " · last check failed" : ""}</>}
				</span>
				{row.items > 0 && (
					<Link
						to="/"
						search={{ source: [row.source] }}
						style={{
							marginLeft: "auto",
							fontSize: 12,
							color: "var(--accent-text)",
							whiteSpace: "nowrap",
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
				fontSize: 12,
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
				style={{ fontSize: 14, color: value ? "var(--text)" : "var(--muted)", fontVariantNumeric: "tabular-nums" }}
			>
				{value.toLocaleString()}
			</span>
			<span style={{ fontSize: 12, color: "var(--muted)" }}>{label}</span>
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
			style={{
				marginLeft: push ? "auto" : undefined,
				fontSize: 12,
				padding: "2px 6px",
				borderRadius: 3,
				border: "1px solid var(--edge)",
				color: mode === "manual" ? "var(--muted)" : "var(--accent-text)",
			}}
		>
			{mode.charAt(0).toUpperCase() + mode.slice(1)}
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
					style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}
				>
					Off keeps everything Anansi has captured
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
