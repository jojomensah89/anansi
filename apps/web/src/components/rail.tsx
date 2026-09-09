import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarTrigger,
} from "@anansi/ui/components/sidebar";
import { CountBone, useSlowLoad } from "./skeleton.tsx";
import { SourceMark } from "./sourcemark.tsx";
import { ExtensionIcon } from "./extension-icon.tsx";
import { api, sourceLabel, type ExtensionHealth } from "../lib/api.ts";
import { extensionLabel } from "../lib/source-state.ts";
import { GITHUB_URL, X_URL } from "../lib/links.ts";

/** The library rail. The shell owns counts so navigation and content agree. */
export interface RailProps {
	total: number;
	authors: number;
	archived?: number;
	bySource: Record<string, number>;
	ready?: boolean;
}

function NavIcon({ path, active }: { path: string; active: boolean }) {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={active ? "var(--accent)" : "var(--faint)"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d={path} />
		</svg>
	);
}

function Item({ to, label, count, active, children }: { to: string; label: string; count?: React.ReactNode; active: boolean; children: React.ReactNode }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton render={<Link to={to} />} isActive={active} tooltip={label} aria-label={label}>
				{children}
				<span className="anansi-sidebar-label">{label}</span>
				{count !== undefined && <span className="anansi-sidebar-count mono">{count}</span>}
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function XIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.2l7.3-8.3L1.6 2H8l4.4 5.9L18.9 2Zm-1.1 17.8h1.7L7 3.9H5.2l12.6 15.9Z" />
		</svg>
	);
}

function GitHubIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1-.6 2V21" />
		</svg>
	);
}

/** Pure so it renders without router/sidebar context and stays testable. */
export function RailSocialLinks() {
	return (
		<div className="anansi-rail-social">
			<a href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="Follow on X" title="Follow on X" className="anansi-rail-social-link">
				<XIcon />
				<span className="anansi-sidebar-label">Follow on X</span>
			</a>
			<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label="Anansi on GitHub" title="Anansi on GitHub" className="anansi-rail-social-link">
				<GitHubIcon />
				<span className="anansi-sidebar-label">GitHub</span>
			</a>
		</div>
	);
}

export function Rail({ total, authors, archived = 0, bySource, ready: readyProp }: RailProps) {
	const [extension, setExtension] = useState<ExtensionHealth | null>(null);
	const [tags, setTags] = useState<{ label: string; color: string; count: number; kind: "topic" | "custom" }[]>([]);
	const path = useRouterState({ select: (s) => s.location.pathname });
	const archivedView = useRouterState({ select: (s) => s.location.pathname === "/" && (s.location.search as Record<string, unknown>).archived === true });
	const ready = readyProp ?? (total > 0 || archived > 0);
	const slow = useSlowLoad(!ready);
	const count = (n: number) => ready ? String(n) : slow ? <CountBone digits={4} height={8} /> : null;
	useEffect(() => {
		const controller = new AbortController();
		api.sources(controller.signal).then((result) => setExtension(result.extension)).catch(() => setExtension(null));
		api.tags(controller.signal).then((result) => setTags(result.tags)).catch(() => setTags([]));
		return () => controller.abort();
	}, []);
	const topics = tags.filter((tag) => tag.kind === "topic" && tag.count > 0).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	const extensionText = extension ? extensionLabel(extension) : "Extension status unavailable";
	const extensionColor = extension?.connection === "connected" ? "var(--ok)" : extension ? "var(--accent-text)" : "var(--faint)";

	return (
		<Sidebar className="anansi-rail" collapsible="icon">
			<SidebarHeader className="anansi-rail-brand">
				<div className="anansi-rail-brand-name">
					<img src="/favicon.png" width="20" height="20" alt="" aria-hidden="true" style={{ borderRadius: 6, objectFit: "cover" }} />
					<span className="anansi-sidebar-label">Anansi</span>
				</div>
				<SidebarTrigger />
			</SidebarHeader>

			<SidebarContent>
				<SidebarGroup className="anansi-rail-primary">
					<SidebarGroupContent>
						<SidebarMenu>
							<Item to="/" label="Library" count={count(total)} active={!archivedView && (path === "" || path === "/")}>
								<NavIcon active={!archivedView && (path === "" || path === "/")} path="M6 4h12v17l-6-4-6 4z" />
							</Item>
							<SidebarMenuItem>
								<SidebarMenuButton render={<Link to="/" search={{ archived: true }} />} isActive={archivedView} tooltip="Archived" aria-label="Archived">
									<NavIcon active={archivedView} path="M4 7h16v13H4zM3 4h18v3H3zM9 11h6" />
									<span className="anansi-sidebar-label">Archived</span>
									<span className="anansi-sidebar-count mono">{count(archived)}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							<Item to="/creators" label="Authors" count={count(authors)} active={path === "/creators"}>
								<NavIcon active={path === "/creators"} path="M9 11.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 6.2a3 3 0 0 1 0 5.6M17.5 19c0-2-.6-3.6-1.7-4.6" />
							</Item>
							<Item to="/sources" label="Sources" active={path === "/sources"}>
								<NavIcon active={path === "/sources"} path="M4 7h16M4 12h16M4 17h9" />
							</Item>
							<Item to="/mcp" label="MCP server" active={path === "/mcp"}>
								<NavIcon active={path === "/mcp"} path="M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01M11 7h6M11 17h6" />
							</Item>
							<Item to="/settings" label="Settings" active={path === "/settings"}>
								<NavIcon active={path === "/settings"} path="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4.9 6.9l1.4 1.4M17.7 8.3l1.4-1.4M12 3v2M12 19v2M3 12h2M19 12h2" />
							</Item>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>

				<SidebarGroup className="anansi-rail-sources-group">
					<SidebarGroupLabel className="anansi-rail-sources mono">Sources</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{(["x", "github", "reddit", "web"] as const).map((source) => {
								return (
									<SidebarMenuItem key={source}>
										<SidebarMenuButton render={<Link to="/" search={{ source: [source] }} />} tooltip={sourceLabel(source)} aria-label={sourceLabel(source)}>
											<span className="anansi-source-icon"><SourceMark source={source} size={15} /></span>
											<span className="anansi-sidebar-label">{sourceLabel(source)}</span>
											<span className="anansi-sidebar-count mono">{count(bySource[source] ?? 0)}</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								);
							})}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>

				{topics.length > 0 && <SidebarGroup className="anansi-rail-topics-group">
					<SidebarGroupLabel className="anansi-rail-topics mono">Topics</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{topics.map((topic) => <SidebarMenuItem key={topic.label}>
								<SidebarMenuButton render={<Link to="/" search={{ tag: [topic.label] }} />} tooltip={topic.label} aria-label={topic.label}>
									<span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: topic.color || "#6b7280" }} />
									<span className="anansi-sidebar-label">{topic.label}</span>
									<span className="anansi-sidebar-count mono">{topic.count}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>)}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>}
			</SidebarContent>

			<SidebarFooter className="anansi-rail-footer">
				<div className="anansi-rail-extension" title={extensionText} aria-label={extensionText}>
					<span className="anansi-rail-extension-icon" style={{ color: extensionColor }}><ExtensionIcon /></span>
					<span className="anansi-rail-extension-dot" style={{ background: extensionColor }} />
					<span className="mono anansi-sidebar-label" style={{ fontSize: 10.5, color: extensionColor }}>{extensionText}</span>
				</div>
				<RailSocialLinks />
			</SidebarFooter>
		</Sidebar>
	);
}
