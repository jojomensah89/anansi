import { MCP_TOOL_CATALOG, MCP_WRITE_TOOL_CATALOG } from "@anansi/mcp/catalog";
import { Button } from "@anansi/ui/components/button";
import { RadioGroup, RadioGroupItem } from "@anansi/ui/components/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@anansi/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@anansi/ui/components/toggle-group";
import { Check, Copy, Lock } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api.ts";
import { ConnectedClients } from "./connected-clients.tsx";
import { clientSnippet, MCP_CLIENTS, MCP_TOKEN_PLACEHOLDER, type McpClientId } from "./mcp-config.ts";
import { Rail } from "./rail.tsx";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;
type CopyTarget = "endpoint" | "snippet";

const emptySubscribe = () => () => {};
const getClientOrigin = () => (typeof window !== "undefined" ? window.location.origin : "");
const getServerOrigin = () => "";

/** Catalog summaries end in a full stop; short lines on this page do not. */
const plain = (summary: string) => summary.replace(/\.$/, "").replace(/, and /g, " and ");

export const MCP_TOOL_COUNT = MCP_TOOL_CATALOG.length + MCP_WRITE_TOOL_CATALOG.length;

/** The address agents connect to: this origin's /mcp. */
export function useMcpEndpoint(): string {
	const origin = useSyncExternalStore(emptySubscribe, getClientOrigin, getServerOrigin);
	return `${origin}/mcp`;
}

function useCopy() {
	const [copied, setCopied] = useState<CopyTarget | null>(null);
	const copy = async (target: CopyTarget, value: string) => {
		try {
			if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
			await navigator.clipboard.writeText(value);
			setCopied(target);
			window.setTimeout(() => setCopied((current) => (current === target ? null : current)), 1800);
		} catch {
			// The text stays on screen and selectable for copying by hand.
			setCopied(null);
		}
	};
	return { copied, copy };
}

/** The endpoint in a read-only field with its Copy button, joined. */
export function McpAddress({ endpoint }: { endpoint: string }) {
	const { copied, copy } = useCopy();
	return (
		<div className="settings-joined mcp-endpoint-field">
			<code className="connect-value" aria-label="MCP endpoint" title={endpoint}>{endpoint}</code>
			<Button variant="outline" onClick={() => void copy("endpoint", endpoint)} aria-label={copied === "endpoint" ? "Copied" : "Copy MCP endpoint"}>
				{copied === "endpoint" ? <Check {...ICON} /> : <Copy {...ICON} />}
				<span className="mcp-copy-label">{copied === "endpoint" ? "Copied" : "Copy"}</span>
			</Button>
		</div>
	);
}

const CLIENT_ITEMS = MCP_CLIENTS.map((client) => ({ value: client.id, label: client.label }));

/**
 * Pick a client and a sign-in, read the setup it needs, copy it. The MCP page
 * lists the clients; Settings, which has less room, uses a select.
 */
export function McpClientSetup({ endpoint, picker = "list" }: { endpoint: string; picker?: "list" | "select" }) {
	const [selectedClient, setSelectedClient] = useState<McpClientId>("claude-code");
	const [mode, setMode] = useState<"oauth" | "key">("oauth");
	const { copied, copy } = useCopy();
	const snippet = useMemo(() => clientSnippet(selectedClient, endpoint, mode), [endpoint, selectedClient, mode]);

	return (
		<div className="mcp-connect-body" data-picker={picker}>
			{picker === "list" && (
				<RadioGroup className="mcp-clients" aria-label="Client" value={selectedClient} onValueChange={(value) => setSelectedClient(value as McpClientId)}>
					{MCP_CLIENTS.map((client) => (
						<label key={client.id} className="mcp-client" data-selected={selectedClient === client.id || undefined}>
							<RadioGroupItem value={client.id} />
							<span>{client.label}</span>
						</label>
					))}
				</RadioGroup>
			)}

			<div className="mcp-signin">
				{picker === "select" ? (
					<Select items={CLIENT_ITEMS} value={selectedClient} onValueChange={(value) => { if (value) setSelectedClient(value as McpClientId); }}>
						<SelectTrigger className="settings-select" aria-label="Client">
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="settings-select-content" alignItemWithTrigger={false} align="start">
							{CLIENT_ITEMS.map((client) => (
								<SelectItem key={client.value} value={client.value}>{client.label}</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : (
					<span id="signin-label">Sign-in</span>
				)}
				<ToggleGroup
					className="mcp-segment"
					aria-label={picker === "select" ? "Sign-in" : undefined}
					aria-labelledby={picker === "list" ? "signin-label" : undefined}
					value={[mode]}
					onValueChange={(values) => { if (values[0]) setMode(values[0] as "oauth" | "key"); }}
				>
					<ToggleGroupItem value="oauth">OAuth</ToggleGroupItem>
					<ToggleGroupItem value="key">API key</ToggleGroupItem>
				</ToggleGroup>
			</div>

			<pre className="mcp-snippet"><code>{snippet}</code></pre>

			<p className="mcp-hint">
				{mode === "key" ? (
					<>Create an API key under Connected, then replace <code>{MCP_TOKEN_PLACEHOLDER}</code></>
				) : selectedClient === "claude-desktop" ? (
					"Add the address as a custom connector, then approve access in your browser. Starts read-only, never deletes"
				) : (
					"Approve access in your browser when the client asks. Starts read-only, never deletes"
				)}
			</p>

			<Button variant="outline" className="mcp-copy-setup" onClick={() => void copy("snippet", snippet)} aria-label={copied === "snippet" ? "Copied" : "Copy setup"}>
				{copied === "snippet" ? <Check {...ICON} /> : <Copy {...ICON} />}
				{copied === "snippet" ? "Copied" : "Copy setup"}
			</Button>
		</div>
	);
}

function ToolColumn({ title, tools }: { title?: ReactNode; tools: ReadonlyArray<{ name: string; summary: string }> }) {
	return (
		<div className="mcp-tool-column">
			<div className="mcp-tool-group">{title ?? <span aria-hidden="true">&nbsp;</span>}</div>
			<ul>
				{tools.map((tool) => (
					<li key={tool.name} className="mcp-tool">
						<code>{tool.name}</code>
						<p>{plain(tool.summary)}</p>
					</li>
				))}
			</ul>
		</div>
	);
}

export function McpServerPage() {
	const endpoint = useMcpEndpoint();
	const [ready, setReady] = useState(false);
	const [stats, setStats] = useState({ items: 0, authors: 0, archived: 0, bySource: {} as Record<string, number> });

	useEffect(() => {
		const controller = new AbortController();
		api
			.stats(controller.signal)
			.then((next) => {
				setStats({ items: next.items, authors: next.authors, archived: next.archived, bySource: next.bySource });
				setReady(true);
			})
			.catch(() => {});
		return () => controller.abort();
	}, []);

	const readHalf = Math.ceil(MCP_TOOL_CATALOG.length / 2);

	return (
		<div className="anansi-shell">
			<Rail ready={ready} total={stats.items} authors={stats.authors} archived={stats.archived} bySource={stats.bySource} />

			{/* The top bar names the page; the address leads the content. */}
			<main className="workspace-page mcp-page">
				<div className="scroll workspace-page-body">
					<div className="mcp-layout">
						<div className="mcp-address-bar">
							<span className="mcp-endpoint-label">Streamable HTTP</span>
							<McpAddress endpoint={endpoint} />
						</div>

						<div className="mcp-grid">
							<ConnectedClients />

							<section className="mcp-panel mcp-connect" aria-labelledby="connect-title">
								<div className="mcp-panel-head">
									<h2 id="connect-title">Connect an agent</h2>
								</div>
								<McpClientSetup endpoint={endpoint} />
							</section>
						</div>

						<section className="mcp-panel mcp-tools" aria-labelledby="tools-title">
							<div className="mcp-panel-head">
								<h2 id="tools-title">Tools</h2>
								<span className="mcp-count">{MCP_TOOL_COUNT}</span>
								<span className="mcp-panel-note">Search matches by meaning when AI is on, by keyword otherwise</span>
							</div>
							<div className="mcp-tool-grid">
								<ToolColumn title="Read" tools={MCP_TOOL_CATALOG.slice(0, readHalf)} />
								<ToolColumn tools={MCP_TOOL_CATALOG.slice(readHalf)} />
								<ToolColumn
									title={<><span>Write</span><Lock {...ICON} /><span className="mcp-tool-group-note">needs read and write access</span></>}
									tools={MCP_WRITE_TOOL_CATALOG}
								/>
							</div>
						</section>
					</div>
				</div>
			</main>
		</div>
	);
}
