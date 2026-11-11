import { Badge } from "@anansi/ui/components/badge";
import { Button } from "@anansi/ui/components/button";
import { Switch } from "@anansi/ui/components/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@anansi/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, ChevronRight, Download, Play, RotateCcw } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConnectExtension } from "../components/connect-extension.tsx";
import { Rail } from "../components/rail.tsx";
import { SourceCardsSkeleton, useSlowLoad } from "../components/skeleton.tsx";
import { SourceMark } from "../components/sourcemark.tsx";
import { api, type ExtensionHealth, type SourceRow, type SourcesResponse } from "../lib/api.ts";
import { requestExtensionImport } from "../lib/extension-bridge.ts";
import { type SourceAction, sourceAction, sourcePresentation } from "../lib/source-state.ts";

export const Route = createFileRoute("/sources")({ component: Sources });

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;
const CHECKED_SOURCES = new Set(["x", "reddit", "github", "tiktok"]);

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

/** How saves arrived, in the order the bar draws them. */
function arrivals(row: SourceRow) {
	return [
		{ key: "live", label: "Live", value: row.live },
		{ key: "imported", label: "Imported", value: row.imported },
		{ key: "manual", label: "Manual", value: row.toolbar + row.contextMenu },
		{ key: "chrome", label: "Chrome", value: row.chromeBookmarks },
		{ key: "legacy", label: "Legacy", value: row.legacyUnknown },
	];
}

type ImportAsk = { state: "asking" } | { state: "sent" } | { state: "missed" };

function Sources() {
	const [data, setData] = useState<SourcesResponse | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [open, setOpen] = useState<string | null>(null);
	const [asks, setAsks] = useState<Record<string, ImportAsk>>({});
	const [stats, setStats] = useState({ items: 0, authors: 0, archived: 0, bySource: {} as Record<string, number> });

	const load = useCallback((signal?: AbortSignal) => {
		Promise.all([api.stats(signal), api.sources(signal)])
			.then(([nextStats, nextSources]) => {
				setStats({ items: nextStats.items, authors: nextStats.authors, archived: nextStats.archived, bySource: nextStats.bySource });
				setData(nextSources);
				setLoadFailed(false);
				// A sent import now shows in the source's own status.
				setAsks((previous) => Object.fromEntries(Object.entries(previous).filter(([, ask]) => ask.state !== "sent")));
			})
			.catch((error: unknown) => {
				if ((error as { name?: string }).name !== "AbortError") setLoadFailed(true);
			});
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const toggle = (row: SourceRow, enabled: boolean) => {
		const set = (value: boolean) =>
			setData((previous) => previous && { ...previous, sources: previous.sources.map((entry) => (entry.source === row.source ? { ...entry, enabled: value } : entry)) });
		set(enabled);
		api.toggleSource(row.source, enabled).catch(() => {
			set(!enabled);
			toast.error(`Couldn't turn ${enabled ? "on" : "off"} ${row.name}`);
		});
	};

	const askImport = async (source: string) => {
		setAsks((previous) => ({ ...previous, [source]: { state: "asking" } }));
		const ok = await requestExtensionImport(source);
		setAsks((previous) => ({ ...previous, [source]: { state: ok ? "sent" : "missed" } }));
		if (ok) window.setTimeout(() => load(), 1500);
	};

	const slow = useSlowLoad(data === null && !loadFailed);

	return (
		<div className="anansi-shell">
			<Rail total={stats.items} authors={stats.authors} archived={stats.archived} bySource={stats.bySource} ready={data !== null} />
			<main className="workspace-page">
				<header className="workspace-page-head">
					<h1>Sources</h1>
					<div className="workspace-page-tools">
						<ConnectExtension />
					</div>
				</header>
				<div className="scroll workspace-page-body">
					{!data && !loadFailed && slow && <SourceCardsSkeleton />}
					{loadFailed && (
						<div className="sources-notice" role="alert">
							<AlertCircle {...ICON} />
							<span>Couldn't load source status. Your library is unaffected</span>
							<Button variant="outline" size="sm" onClick={() => load()}>
								<RotateCcw {...ICON} />
								Try again
							</Button>
						</div>
					)}
					{data && (
						<>
							<div className="sources-panel sources-table">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Source</TableHead>
											<TableHead>Status</TableHead>
											<TableHead className="sources-num">Saves</TableHead>
											<TableHead className="sources-num">Authors</TableHead>
											<TableHead>Last capture</TableHead>
											<TableHead><span className="sr-only">Action</span></TableHead>
											<TableHead className="sources-num">Capture</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.sources.map((row) => (
											<SourceTableRow
												key={row.source}
												row={row}
												extension={data.extension}
												expanded={open === row.source}
												onExpand={() => setOpen((current) => (current === row.source ? null : row.source))}
												ask={asks[row.source]}
												onImport={askImport}
												onToggle={toggle}
											/>
										))}
									</TableBody>
								</Table>
							</div>
							<ul className="sources-panel sources-list" aria-label="Sources">
								{data.sources.map((row) => (
									<SourceListItem key={row.source} row={row} extension={data.extension} ask={asks[row.source]} onImport={askImport} onToggle={toggle} />
								))}
							</ul>
						</>
					)}
				</div>
			</main>
		</div>
	);
}

interface RowProps {
	row: SourceRow;
	extension: ExtensionHealth;
	ask?: ImportAsk;
	onImport: (source: string) => void;
	onToggle: (row: SourceRow, enabled: boolean) => void;
}

function Status({ row, extension, ask }: Pick<RowProps, "row" | "extension" | "ask">) {
	const status = sourcePresentation(row, extension);
	return (
		<span className="sources-status-wrap">
			<span className="sources-status" data-tone={status.tone}>
				<span className="sources-dot" data-tone={status.tone} aria-hidden="true" />
				<span>{status.text}</span>
			</span>
			{ask?.state === "missed" && <span className="sources-ask" role="status">Open the extension popup to import</span>}
			{ask?.state === "sent" && <span className="sources-ask-ok" role="status">Import started</span>}
		</span>
	);
}

function Action({ row, extension, ask, onImport }: Pick<RowProps, "row" | "extension" | "ask" | "onImport">) {
	const status = sourcePresentation(row, extension);
	const action: SourceAction = sourceAction(row, status);
	const away = status.state === "disconnected";
	if (action === "view")
		return (
			<Link to="/" search={{ source: [row.source] }} className="sources-view">
				View in library
			</Link>
		);
	if (!action) return null;
	const [text, Icon] = action === "import" ? ["Import everything", Download] as const : action === "resume" ? ["Resume", Play] as const : ["Try again", RotateCcw] as const;
	const asking = ask?.state === "asking";
	return (
		<Button variant="outline" size="sm" className="sources-action" disabled={away || asking || ask?.state === "sent"} onClick={() => onImport(row.source)}>
			<Icon {...ICON} />
			{asking ? "Asking the extension" : text}
		</Button>
	);
}

function Capture({ row, onToggle }: Pick<RowProps, "row" | "onToggle">) {
	if (row.toggleable)
		return <Switch aria-label={`Capture ${row.name}`} checked={row.enabled} onCheckedChange={(next) => onToggle(row, next)} />;
	if (row.mode === "manual") return <Badge variant="outline" className="settings-badge">Manual</Badge>;
	return null;
}

function SourceTableRow({ row, extension, expanded, onExpand, ask, onImport, onToggle }: RowProps & { expanded: boolean; onExpand: () => void }) {
	const status = sourcePresentation(row, extension);
	const check = extension.sources[row.source];
	const failed = Boolean(check?.lastErrorCode);
	const parts = arrivals(row);
	const detailId = `source-detail-${row.source}`;
	return (
		<Fragment>
			<TableRow className="sources-row" data-open={expanded || undefined} data-off={status.state === "disabled" || undefined}>
				<TableCell>
					<div className="sources-name">
						<Button
							variant="ghost"
							size="icon-sm"
							className="sources-chevron"
							aria-expanded={expanded}
							aria-controls={detailId}
							aria-label={`How ${row.name} saves arrived`}
							onClick={onExpand}
						>
							<ChevronRight {...ICON} />
						</Button>
						<SourceMark source={row.source} size={20} decorative />
						<span className="sources-name-text">
							<span className="sources-title">{row.name}</span>
							<span className="sources-host">{row.host}</span>
						</span>
					</div>
				</TableCell>
				<TableCell><Status row={row} extension={extension} ask={ask} /></TableCell>
				<TableCell className="sources-num sources-figure">{row.items.toLocaleString()}</TableCell>
				<TableCell className="sources-num sources-figure sources-dim">{row.authors.toLocaleString()}</TableCell>
				<TableCell>
					<span className="sources-when">
						<span>{ago(row.lastCaptureAt)}</span>
						{CHECKED_SOURCES.has(row.source) && (
							<span className="sources-host" data-tone={failed ? "warn" : undefined}>
								{failed ? "last check failed" : check?.lastCheckedAt ? `checked ${ago(check.lastCheckedAt)}` : "not checked yet"}
							</span>
						)}
					</span>
				</TableCell>
				<TableCell className="sources-num"><Action row={row} extension={extension} ask={ask} onImport={onImport} /></TableCell>
				<TableCell className="sources-num"><Capture row={row} onToggle={onToggle} /></TableCell>
			</TableRow>
			{expanded && (
				<TableRow className="sources-detail" data-open>
					<TableCell colSpan={7} id={detailId}>
						<div className="sources-arrivals">
							<span className="sources-host">How saves arrived</span>
							{row.items > 0 && (
								<div className="sources-stack" aria-hidden="true">
									{parts.filter((part) => part.value > 0).map((part) => <i key={part.key} data-part={part.key} style={{ flexGrow: part.value }} />)}
								</div>
							)}
							<dl className="sources-legend">
								{parts.map((part) => (
									<div key={part.key}>
										<dt>{part.value > 0 && <span className="sources-swatch" data-part={part.key} />}{part.label}</dt>
										<dd data-zero={part.value === 0 || undefined}>{part.value.toLocaleString()}</dd>
									</div>
								))}
							</dl>
							{row.items > 0 && (
								<Link to="/" search={{ source: [row.source] }} className="sources-view-all">
									View {row.items.toLocaleString()} in library
									<ChevronRight {...ICON} />
								</Link>
							)}
						</div>
					</TableCell>
				</TableRow>
			)}
		</Fragment>
	);
}

/** Phone: one line per platform, its count, its switch, and the action underneath. */
function SourceListItem({ row, extension, ask, onImport, onToggle }: RowProps) {
	const action = sourceAction(row, sourcePresentation(row, extension));
	return (
		<li className="sources-item">
			<div className="sources-item-line">
				<SourceMark source={row.source} size={20} decorative />
				<span className="sources-name-text">
					<span className="sources-title">{row.name}</span>
					<Status row={row} extension={extension} ask={ask} />
				</span>
				<span className="sources-figure">{row.items.toLocaleString()}</span>
				<Capture row={row} onToggle={onToggle} />
			</div>
			{action && action !== "view" && (
				<div className="sources-item-action">
					<Action row={row} extension={extension} ask={ask} onImport={onImport} />
				</div>
			)}
		</li>
	);
}
