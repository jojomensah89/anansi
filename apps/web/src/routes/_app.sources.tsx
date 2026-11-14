import { Button } from "@anansi/ui/components/button";
import { Switch } from "@anansi/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@anansi/ui/components/toggle-group";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, Download, Play, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ConnectExtension } from "../components/connect-extension.tsx";
import { ExtensionIcon } from "../components/extension-icon.tsx";
import { Bone, Loading, useSlowLoad } from "../components/skeleton.tsx";
import { SourceMark } from "../components/sourcemark.tsx";
import { StatusDot } from "../components/status-dot.tsx";
import type { ExtensionHealth, SourceRow } from "../lib/api.ts";
import { formatCount } from "../lib/format.ts";
import { expectIncomingSaves } from "../lib/library-query.ts";
import { useSources, useToggleSource } from "../lib/source-queries.ts";
import { requestExtensionImport } from "../lib/extension-bridge.ts";
import { useExtensionHealth } from "../lib/frame-status.ts";
import { extensionStatus, importable, type SourceAction, type SourcePresentation, sourceAction, sourcePresentation } from "../lib/source-state.ts";

export const Route = createFileRoute("/_app/sources")({ component: Sources });

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;

/** "just now", "4 min ago", "3 h ago", "yesterday", "6 days ago". */
export function ago(unix: number | null, now = Date.now()): string {
	if (!unix) return "Never";
	const minutes = Math.max(0, Math.round((now - unix * 1000) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The figures under a source: what it holds, then how most of it arrived. */
export function sourceCounts(row: SourceRow): string[] {
	const parts = [`${formatCount(row.items)} saved`];
	if (importable(row)) parts.push(`${formatCount(row.imported)} imported`);
	else if (row.chromeBookmarks > 0) parts.push(`${formatCount(row.chromeBookmarks)} bookmarks`);
	return parts;
}

/** The footer's one line: when it last worked, or what is in the way. */
export function sourceFooter(row: SourceRow, status: SourcePresentation): { text: string; tone: "ok" | "accent" | "warn" | "muted" } {
	switch (status.state) {
		case "disabled":
			return { text: "Off", tone: "muted" };
		case "running":
			return { text: status.text, tone: "accent" };
		// The reason is long ("Sign in to TikTok, then try again"), so the card body says it.
		case "failed":
			return { text: importable(row) ? "Import failed" : "Capture failed", tone: "warn" };
		case "retrying":
			return { text: "Retrying", tone: "warn" };
		case "disconnected":
		case "paused":
		case "queued":
			return { text: status.text, tone: "muted" };
		default:
			return row.lastCaptureAt
				? { text: `Last capture ${ago(row.lastCaptureAt)}`, tone: "ok" }
				: { text: "No captures yet", tone: "muted" };
	}
}

type ImportAsk = "asking" | "sent";
type Filter = "all" | "on";

function Sources() {
	const sources = useSources();
	const { mutate: toggleSource } = useToggleSource();
	const [asks, setAsks] = useState<Record<string, ImportAsk>>({});
	const [filter, setFilter] = useState<Filter>("all");
	const data = sources.data;
	const { refetch } = sources;

	const toggle = useCallback((row: SourceRow, enabled: boolean) => toggleSource({ row, enabled }), [toggleSource]);

	const askImport = useCallback(async (row: SourceRow) => {
		setAsks((previous) => ({ ...previous, [row.source]: "asking" }));
		const ok = await requestExtensionImport(row.source);
		setAsks((previous) => {
			const next = { ...previous };
			if (ok) next[row.source] = "sent";
			else delete next[row.source];
			return next;
		});
		if (!ok) {
			toast.error("The extension didn’t answer", { description: "Open the extension popup to import" });
			return;
		}
		toast.success(`${row.name}: import started`);
		// Saves are about to arrive: the rail's counts check quickly for a while.
		expectIncomingSaves();
		// A sent import then shows in the source's own status.
		window.setTimeout(() => {
			void refetch().then(() => setAsks((previous) => Object.fromEntries(Object.entries(previous).filter(([source, ask]) => source !== row.source || ask !== "sent"))));
		}, 1500);
	}, [refetch]);

	const loadFailed = sources.isError && !data;
	const slow = useSlowLoad(sources.isPending);
	// Coming-next platforms are not sources yet; they get no card.
	const rows = data?.sources.filter((row) => row.support !== "coming_next") ?? [];
	const onCount = rows.filter((row) => row.enabled).length;
	const shown = filter === "on" ? rows.filter((row) => row.enabled) : rows;

	return (
		<main className="workspace-page sources-page">
			<div className="scroll sources-scroll">
				<div className="sources-frame">
					<ExtensionCard fallback={data?.extension} />

					{loadFailed && (
						<div className="sources-notice" role="alert">
							<AlertCircle {...ICON} />
							<span>Couldn't load source status. Your library is unaffected</span>
							<Button variant="outline" onClick={() => void refetch()}>
								<RotateCcw {...ICON} />
								Try again
							</Button>
						</div>
					)}

					{!data && !loadFailed && slow && <SourceGridSkeleton />}

					{data && (
						<section className="sources-section" aria-labelledby="sources-title">
							<header className="sources-section-head">
								<h2 id="sources-title">Platforms</h2>
								{onCount < rows.length && (
									<ToggleGroup
										className="sources-filter"
										aria-label="Show"
										value={[filter]}
										onValueChange={(values) => { if (values[0]) setFilter(values[0] as Filter); }}
									>
										<ToggleGroupItem value="all">All <span className="sources-filter-count">{formatCount(rows.length)}</span></ToggleGroupItem>
										<ToggleGroupItem value="on">On <span className="sources-filter-count">{formatCount(onCount)}</span></ToggleGroupItem>
									</ToggleGroup>
								)}
							</header>
							<ul className="sources-grid">
								{shown.map((row) => (
									<SourceCard key={row.source} row={row} extension={data.extension} ask={asks[row.source]} onImport={askImport} onToggle={toggle} />
								))}
							</ul>
						</section>
					)}
				</div>
			</div>
		</main>
	);
}

/** The extension, full width above the platforms: everything below depends on it. */
function ExtensionCard({ fallback }: { fallback?: ExtensionHealth }) {
	const health = useExtensionHealth();
	const extension = health.data ?? fallback ?? (health.isError ? null : undefined);
	const status = extensionStatus(extension);
	const connected = extension?.connection === "connected";
	const line =
		status.state === "unknown" ? "Checking"
		: connected ? `Connected${extension?.extensionVersion ? ` · v${extension.extensionVersion}` : ""}`
		: extension?.connection === "disconnected" ? `Offline${extension.lastSeenAt ? ` · last seen ${ago(extension.lastSeenAt)}` : ""}`
		: "Not connected yet";

	return (
		<section className="extension-card" aria-labelledby="extension-title">
			<span className="extension-card-mark"><ExtensionIcon /></span>
			<div className="extension-card-copy">
				<h2 id="extension-title">Anansi extension</h2>
				<p>Captures what you save as you browse, and imports your history</p>
			</div>
			<div className="extension-card-end">
				<span className="extension-card-status" data-tone={status.tone} role="status">
					<StatusDot status={status} />
					<span>{line}</span>
				</span>
				<ConnectExtension
					label={connected ? "Connect another browser" : "Connect"}
					className={connected ? "extension-card-action" : "extension-card-action extension-card-action-primary"}
				/>
			</div>
		</section>
	);
}

interface CardProps {
	row: SourceRow;
	extension: ExtensionHealth;
	ask?: ImportAsk;
	onImport: (row: SourceRow) => void;
	onToggle: (row: SourceRow, enabled: boolean) => void;
}

const ACTION: Record<Exclude<SourceAction, "view" | null>, { text: string; Icon: typeof Download }> = {
	import: { text: "Import", Icon: Download },
	resume: { text: "Resume", Icon: Play },
	retry: { text: "Retry import", Icon: RotateCcw },
};

function SourceCard({ row, extension, ask, onImport, onToggle }: CardProps) {
	const status = sourcePresentation(row, extension);
	const action = sourceAction(row, status);
	const footer = sourceFooter(row, status);
	const off = status.state === "disabled";
	const away = status.state === "disconnected";
	const step = action && action !== "view" ? ACTION[action] : null;

	return (
		<li className="source-card" data-off={off || undefined}>
			<div className="source-card-head">
				<span className="source-card-mark"><SourceMark source={row.source} size={20} decorative /></span>
				<span className="source-card-name">
					<span className="source-card-title">{row.name}</span>
					<span className="source-card-host">{row.host}</span>
				</span>
				{row.toggleable && (
					<Switch aria-label={`Capture ${row.name}`} checked={row.enabled} onCheckedChange={(next) => onToggle(row, next)} />
				)}
			</div>
			{status.state === "failed" || status.state === "retrying" ? (
				<p className="source-card-note" data-tone="warn" role="status">{status.text}</p>
			) : (
				<p className="source-card-note">{row.note}</p>
			)}
			<p className="source-card-counts">
				{sourceCounts(row).map((part, index) => (
					<span key={part} data-lead={index === 0 || undefined}>{part}</span>
				))}
			</p>
			<div className="source-card-foot">
				<span className="source-card-status" data-tone={footer.tone}>
					<span className="source-card-dot" data-tone={footer.tone} aria-hidden="true" />
					<span>{footer.text}</span>
				</span>
				<span className="source-card-actions">
					{step && (
						<Button variant="outline" className="source-card-step" disabled={away || ask !== undefined} onClick={() => onImport(row)}>
							<step.Icon {...ICON} />
							{ask === "asking" ? "Asking" : step.text}
						</Button>
					)}
					{row.items > 0 && (
						<Link to="/" search={{ source: [row.source] }} className="source-card-view" aria-label={`View ${row.name} saves`}>
							{step ? "View" : "View saves"}
							<ArrowRight {...ICON} />
						</Link>
					)}
				</span>
			</div>
		</li>
	);
}

function SourceGridSkeleton() {
	return (
		<Loading label="Loading sources">
			<ul className="sources-grid" style={{ marginTop: 48 }}>
				{Array.from({ length: 5 }, (_, index) => (
					<li key={index} className="source-card">
						<div className="source-card-head">
							<Bone width={20} height={20} radius={5} delay={index * 70} />
							<span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
								<Bone width="50%" height={12} delay={index * 70 + 30} />
								<Bone width="30%" height={10} delay={index * 70 + 60} />
							</span>
						</div>
						<Bone width="80%" height={12} delay={index * 70 + 90} />
						<Bone width="44%" height={12} delay={index * 70 + 120} />
					</li>
				))}
			</ul>
		</Loading>
	);
}
