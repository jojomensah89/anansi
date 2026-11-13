import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Bot, Database, KeyRound, Library, type LucideIcon, Sparkles } from "lucide-react";
import { Rail } from "../components/rail.tsx";
import { useLibraryStats } from "../components/settings-sections.tsx";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settings-sections.ts";

/**
 * Settings: a column of areas on the left, the chosen area's panels on the
 * right. Each area has its own URL (`/settings/ai`); `/settings` goes to the
 * first. The top bar names the page, so the content carries no title of its own.
 */
export const Route = createFileRoute("/settings")({ component: SettingsLayout });

const ICONS: Record<SettingsSectionId, LucideIcon> = {
	library: Library,
	ai: Sparkles,
	agents: Bot,
	security: KeyRound,
	data: Database,
};

function SettingsLayout() {
	const stats = useLibraryStats();
	const counts = stats.data;
	return (
		<div className="anansi-shell">
			<Rail total={counts?.items ?? 0} authors={counts?.authors ?? 0} archived={counts?.archived ?? 0} bySource={counts?.bySource ?? {}} ready={counts !== undefined} />
			<main className="workspace-page settings-page">
				<div className="scroll settings-scroll">
					<div className="settings-frame">
						<SettingsNav />
						<div className="settings-content">
							<Outlet />
						</div>
					</div>
				</div>
			</main>
		</div>
	);
}

function SettingsNav() {
	const path = useRouterState({ select: (state) => state.location.pathname });
	return (
		<nav className="settings-nav" aria-label="Settings">
			<ul>
				{SETTINGS_SECTIONS.map((section) => {
					const Icon = ICONS[section.id];
					const active = path === `/settings/${section.id}`;
					return (
						<li key={section.id}>
							<Link
								to="/settings/$section"
								params={{ section: section.id }}
								className="settings-nav-link"
								aria-current={active ? "page" : undefined}
							>
								<Icon aria-hidden="true" strokeWidth={1.5} />
								<span>{section.label}</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
