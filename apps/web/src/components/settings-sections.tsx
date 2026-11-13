import { Button } from "@anansi/ui/components/button";
import { Switch } from "@anansi/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { api } from "../lib/api.ts";
import { libraryKeys } from "../lib/library-query.ts";
import type { SettingsSectionId } from "../lib/settings-sections.ts";
import { useHideRemoved, useShowNsfw } from "../lib/settings.ts";
import { AiLoadError, AiSettings, useAiSettings } from "./ai-settings.tsx";
import { ConnectedClients } from "./connected-clients.tsx";
import { DataSettings } from "./data-settings.tsx";
import { MCP_TOOL_COUNT, McpAddress, McpClientSetup, useMcpEndpoint } from "./mcp-server.tsx";
import { PasskeySettings, SessionSettings } from "./passkey-settings.tsx";
import { SettingsRow, SettingsSection } from "./settings-panel.tsx";
import { SettingsSkeleton } from "./skeleton.tsx";
import { SyncSettings } from "./sync-controls.tsx";
import { TopicsEditor } from "./topics-editor.tsx";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;

/** The library's counts, shared with the rail and the library page. */
export function useLibraryStats() {
	return useQuery({ queryKey: libraryKeys.stats(), queryFn: ({ signal }) => api.stats(signal), retry: 1, staleTime: 15_000 });
}

/** A quiet link that reads as a button: it goes somewhere rather than changing something. */
function GoTo({ to, children }: { to: "/sources" | "/mcp"; children: string }) {
	return (
		<Button variant="outline" render={<Link to={to} />} nativeButton={false} className="settings-goto">
			{children}
			<ArrowUpRight {...ICON} />
		</Button>
	);
}

function LibrarySection() {
	const [showNsfw, setShowNsfw] = useShowNsfw();
	const [hideRemoved, setHideRemoved] = useHideRemoved();
	return (
		<>
			<SettingsSection id="sync" title="Sync" lead="Runs when the library opens">
				<SyncSettings />
				<SettingsRow
					title="Sources"
					description="Turn platforms on or off and import their history"
					control={<GoTo to="/sources">Open Sources</GoTo>}
				/>
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
		</>
	);
}

function AiSection() {
	const ai = useAiSettings();
	const lead =
		ai.data?.runtime === "ollama" ? "Runs through Ollama on this machine"
		: ai.data?.runtime === "cloudflare" ? "Runs in your Cloudflare account. Manual tags are never replaced"
		: ai.data ? "Manual tags are never replaced"
		: undefined;
	return (
		<>
			<SettingsSection id="ai" title="AI" lead={lead}>
				{ai.data ? (
					<AiSettings data={ai.data} setData={ai.setData} />
				) : ai.loadError ? (
					<AiLoadError error={ai.loadError} onRetry={ai.reload} />
				) : (
					<SettingsSkeleton label="Loading AI settings" />
				)}
			</SettingsSection>
			{ai.data?.available !== false && <TopicsEditor onRetagged={ai.reload} />}
		</>
	);
}

function AgentsSection() {
	const endpoint = useMcpEndpoint();
	return (
		<>
			<SettingsSection id="mcp" title="MCP server" lead="Agents read your library through this address">
				<SettingsRow title="Address" description="Streamable HTTP" wide control={<McpAddress endpoint={endpoint} />} />
				<SettingsRow title="Set up a client" description="Starts read-only and never deletes">
					<McpClientSetup endpoint={endpoint} picker="select" />
				</SettingsRow>
				<SettingsRow
					title="Tools"
					description={`${MCP_TOOL_COUNT} tools for searching, reading and tagging`}
					control={<GoTo to="/mcp">View tools</GoTo>}
				/>
			</SettingsSection>
			<ConnectedClients />
		</>
	);
}

function SecuritySection() {
	return (
		<>
			<SettingsSection id="passkeys" title="Passkeys" lead="Sign in with Face ID, Touch ID or a security key">
				<PasskeySettings />
			</SettingsSection>
			<SettingsSection id="sign-in" title="Sign-in" lead="How this library is opened">
				<SessionSettings />
			</SettingsSection>
		</>
	);
}

function DataSection() {
	const stats = useLibraryStats();
	return (
		<SettingsSection id="data" title="Your data" lead={stats.data ? `${stats.data.items.toLocaleString()} saves` : "Export and restore"}>
			<DataSettings />
		</SettingsSection>
	);
}

export function SettingsSectionContent({ section }: { section: SettingsSectionId }) {
	switch (section) {
		case "library":
			return <LibrarySection />;
		case "ai":
			return <AiSection />;
		case "agents":
			return <AgentsSection />;
		case "security":
			return <SecuritySection />;
		case "data":
			return <DataSection />;
	}
}
