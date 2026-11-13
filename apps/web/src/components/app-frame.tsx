import { SidebarTrigger } from "@anansi/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@anansi/ui/components/tooltip";
import { Link, useRouterState } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { Shelf } from "../lib/api.ts";
import { useShelves } from "../lib/shelf-queries.ts";
import { ShelfIcon } from "./shelf-icons.tsx";
import { settingsSection, settingsSectionForHash } from "../lib/settings-sections.ts";
import { aiJobs, extensionTitle, importJobs, useAiBacklog, useExtensionHealth } from "../lib/frame-status.ts";
import { extensionStatus } from "../lib/source-state.ts";
import { ExtensionIcon } from "./extension-icon.tsx";
import { CountBone, useSlowLoad } from "./skeleton.tsx";
import { StatusDot } from "./status-dot.tsx";
import { SyncControls } from "./sync-controls.tsx";

/**
 * The frame every page shares, beside the rail: a slim bar that says where you
 * are and whether the extension is reachable, and a pill in the corner while
 * background work runs. The rail renders it so pages get it without wiring.
 */

interface Crumb {
	label: string;
	to?: string;
	icon?: ReactNode;
}

function crumbsFor(path: string, hash: string, search: Record<string, unknown>, shelves: readonly Shelf[] = []): Crumb[] {
	const clean = path.replace(/\/+$/, "") || "/";
	if (clean === "/" && typeof search.shelf === "string") {
		const shelf = shelves.find((entry) => entry.id === search.shelf);
		return [{ label: "Shelves" }, { label: shelf?.name ?? "Shelf", icon: shelf ? <ShelfIcon icon={shelf.icon} color={shelf.color} /> : undefined }];
	}
	if (clean === "/") {
		if (search.archived === true) return [{ label: "Library", to: "/" }, { label: "Archived" }];
		if (typeof search.q === "string" && search.q) return [{ label: "Library", to: "/" }, { label: "Search" }];
		return [{ label: "Library" }];
	}
	if (clean === "/settings" || clean.startsWith("/settings/")) {
		// "/settings/ai", or an old "/settings#ai" link on its way there.
		const id = clean === "/settings" ? settingsSectionForHash(hash) : clean.slice("/settings/".length);
		const section = settingsSection(id);
		return section ? [{ label: "Settings", to: "/settings" }, { label: section.label }] : [{ label: "Settings" }];
	}
	const names: Record<string, string> = { "/creators": "Authors", "/sources": "Sources", "/mcp": "MCP server" };
	return [{ label: names[clean] ?? "Anansi" }];
}

export function AppTopBar({ total, archived, ready }: { total: number; archived: number; ready: boolean }) {
	const location = useRouterState({ select: (state) => state.location });
	const search = (location.search ?? {}) as Record<string, unknown>;
	const shelves = useShelves();
	const shelf = typeof search.shelf === "string" ? shelves.data?.find((entry) => entry.id === search.shelf) : undefined;
	const crumbs = crumbsFor(location.pathname, location.hash ?? "", search, shelves.data);
	const libraryCount = location.pathname === "/" && !search.q ? (search.shelf ? (shelf?.count ?? null) : search.archived === true ? archived : total) : null;
	const slow = useSlowLoad(!ready);

	return (
		<header className="app-topbar">
			<SidebarTrigger className="app-topbar-toggle" />
			<nav aria-label="Breadcrumb" className="app-crumbs">
				<ol>
					{crumbs.map((crumb, index) => {
						const last = index === crumbs.length - 1;
						return (
							<Fragment key={crumb.label}>
								{index > 0 && <li aria-hidden="true" className="app-crumb-sep">/</li>}
								<li className="app-crumb">
									{crumb.to && !last ? (
										<Link to={crumb.to} className="app-crumb-link">{crumb.label}</Link>
									) : (
										<span aria-current={last ? "page" : undefined} className={crumb.icon ? "app-crumb-with-icon" : undefined}>{crumb.icon}{crumb.label}</span>
									)}
								</li>
							</Fragment>
						);
					})}
				</ol>
				{libraryCount !== null && (
					<span className="app-crumb-count">
						{ready ? <>{libraryCount.toLocaleString("en-GB")}<span className="sr-only"> saves</span></> : slow ? <CountBone digits={4} height={8} /> : null}
					</span>
				)}
			</nav>
			<div className="app-topbar-end">
				<Tooltip>
					<TooltipTrigger render={<span className="app-topbar-sync" />}>
						<SyncControls />
					</TooltipTrigger>
					<TooltipContent side="bottom" sideOffset={6} className="frame-tooltip">Ask the extension to check for new saves</TooltipContent>
				</Tooltip>
				<ExtensionStatus />
			</div>
		</header>
	);
}

function ExtensionStatus() {
	const health = useExtensionHealth();
	const extension = health.data ?? (health.isError ? null : undefined);
	const raw = extensionStatus(health.isError ? null : extension);
	// The bar's dot answers one question, "can captures flow?": an import in
	// progress is connected, so it stays green; the pill reports the import.
	const status = raw.state === "syncing" ? { ...raw, tone: "ok" as const } : raw;
	const title = health.isError ? "Extension status unavailable" : extensionTitle(extension, status.label);
	return (
		<Tooltip>
			<TooltipTrigger render={<Link to="/sources" className="app-extension" aria-label={title} data-state={status.state} />}>
				<ExtensionIcon />
				<StatusDot status={status} />
			</TooltipTrigger>
			<TooltipContent side="bottom" align="end" sideOffset={6} className="frame-tooltip">{title}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Background work, in the corner of the content.
 *
 * One quiet line per job, numbers in tabular figures, and an info mark that
 * says what is happening and where to read more. It leaves as soon as the
 * work is done; nothing here needs an answer.
 */
export function ProgressPill() {
	const extension = useExtensionHealth();
	const ai = useAiBacklog();
	const jobs = [...importJobs(extension.data), ...aiJobs(ai.data)];
	if (jobs.length === 0) return null;

	return (
		<div className="frame-progress" role="status" aria-live="polite">
			{jobs.map((job) => (
				<div key={job.id} className="frame-progress-row">
					<span aria-hidden="true" className="frame-progress-dot" />
					<span className="frame-progress-label">{job.label}…</span>
					<Tooltip>
						<TooltipTrigger
							render={<Link to={job.href} hash={job.hash} className="frame-progress-info" aria-label={`${job.label}. ${job.detail}`} />}
						>
							<Info aria-hidden="true" size={14} strokeWidth={1.5} />
						</TooltipTrigger>
						<TooltipContent side="top" align="start" sideOffset={8} className="frame-tooltip frame-tooltip-wide">{job.detail}</TooltipContent>
					</Tooltip>
				</div>
			))}
		</div>
	);
}
