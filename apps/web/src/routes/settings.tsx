import { Switch } from "@anansi/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AiLoadError, AiSettings, useAiSettings } from "../components/ai-settings.tsx";
import { DataSettings } from "../components/data-settings.tsx";
import { PasskeySettings } from "../components/passkey-settings.tsx";
import { Rail } from "../components/rail.tsx";
import { SettingsSection, SettingsRow } from "../components/settings-panel.tsx";
import { SettingsSkeleton } from "../components/skeleton.tsx";
import { SyncSettings } from "../components/sync-controls.tsx";
import { api } from "../lib/api.ts";
import { useHideRemoved, useShowNsfw } from "../lib/settings.ts";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
	const [counts, setCounts] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
	useEffect(() => { void api.stats().then(setCounts).catch(() => undefined); }, []);
	const [showNsfw, setShowNsfw] = useShowNsfw();
	const [hideRemoved, setHideRemoved] = useHideRemoved();
	const ai = useAiSettings();
	const aiLead = ai.data?.runtime === "ollama" ? "Runs through Ollama on this machine" : ai.data?.runtime === "cloudflare" ? "Runs in your Cloudflare account. Manual tags are never replaced" : ai.data ? "Manual tags are never replaced" : undefined;

	return (
		<div className="anansi-shell">
			<Rail total={counts?.items ?? 0} authors={counts?.authors ?? 0} archived={counts?.archived ?? 0} bySource={counts?.bySource ?? {}} ready={counts !== null} />
			<main className="workspace-page">
				<header className="workspace-page-head">
					<h1>Settings</h1>
				</header>
				<div className="scroll workspace-page-body">
					<div className="settings-layout">
						<SettingsSection id="sync" title="Sync" lead="Runs when the library opens">
							<SyncSettings />
						</SettingsSection>
						<SettingsSection id="ai" title="AI" lead={aiLead}>
							{ai.data ? (
								<AiSettings data={ai.data} setData={ai.setData} />
							) : ai.loadError ? (
								<AiLoadError error={ai.loadError} onRetry={ai.reload} />
							) : (
								<SettingsSkeleton label="Loading AI settings" />
							)}
						</SettingsSection>
						<SettingsSection id="display" title="Display" lead="Kept in this browser">
							<SettingsRow
								title="Show sensitive content"
								description="Posts X and Reddit mark as sensitive or adult"
								control={<Switch aria-label="Show sensitive content" checked={showNsfw} onCheckedChange={setShowNsfw} />}
							/>
							<SettingsRow
								title="Hide items removed at the source"
								description="Off keeps everything Anansi has captured"
								control={<Switch aria-label="Hide items removed at the source" checked={hideRemoved} onCheckedChange={setHideRemoved} />}
							/>
						</SettingsSection>
						<SettingsSection id="sign-in" title="Sign-in" lead="The deploy secret stays your recovery key">
							<PasskeySettings />
						</SettingsSection>
						<SettingsSection id="data" title="Your data" lead={counts ? `${counts.items.toLocaleString()} saves` : undefined}>
							<DataSettings />
						</SettingsSection>
					</div>
				</div>
			</main>
		</div>
	);
}
