import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MCP_TOOL_CATALOG, MCP_WRITE_TOOL_CATALOG } from "@anansi/mcp/catalog";
import { Rail } from "./rail.tsx";
import { clientSnippet, MCP_CLIENTS, MCP_TOKEN_PLACEHOLDER, type McpClientId } from "./mcp-config.ts";
import { api } from "../lib/api.ts";

type CopyTarget = "endpoint" | "snippet";

function CopyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function CopyButton({
  target,
  value,
  copied,
  onCopy,
}: {
  target: CopyTarget;
  value: string;
  copied: CopyTarget | null;
  onCopy: (target: CopyTarget, value: string) => void;
}) {
  const isCopied = copied === target;
  return (
    <button
      type="button"
      onClick={() => onCopy(target, value)}
      aria-label={isCopied ? "Copied" : `Copy ${target === "endpoint" ? "MCP endpoint" : "client setup"}`}
      className="mcp-copy-button"
    >
      {isCopied ? <CheckGlyph /> : <CopyGlyph />}
      {isCopied ? "Copied" : "Copy"}
    </button>
  );
}

const emptySubscribe = () => () => {};
const getClientOrigin = () => (typeof window !== "undefined" ? window.location.origin : "");
const getServerOrigin = () => "";

export function McpServerPage() {
  const origin = useSyncExternalStore(emptySubscribe, getClientOrigin, getServerOrigin);
  const [selectedClient, setSelectedClient] = useState<McpClientId>("claude-code");
  const [mode, setMode] = useState<"oauth" | "key">("oauth");
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [stats, setStats] = useState({ items: 0, authors: 0, archived: 0, bySource: {} as Record<string, number> });

  useEffect(() => {
    const controller = new AbortController();
    api
      .stats(controller.signal)
      .then((next) => { setStats({ items: next.items, authors: next.authors, archived: next.archived, bySource: next.bySource }); setReady(true); })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const endpoint = `${origin}/mcp`;
  const snippet = useMemo(() => clientSnippet(selectedClient, endpoint, mode), [endpoint, selectedClient, mode]);

  const copy = async (target: CopyTarget, value: string) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setCopied(target);
      window.setTimeout(() => setCopied((current) => (current === target ? null : current)), 1800);
    } catch {
      // The text remains selected and readable for manual copying.
      setCopied(null);
    }
  };

  return (
    <div className="mcp-shell" style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
      <Rail ready={ready} total={stats.items} authors={stats.authors} archived={stats.archived} bySource={stats.bySource} />

      <main className="mcp-main scroll">
        <div className="mcp-wrap">
          <header className="mcp-header">
            <h1>MCP server</h1>
            <p>Connect an agent to your library</p>
          </header>

          <section className="mcp-endpoint-card" aria-labelledby="mcp-endpoint-heading">
            <div className="mcp-card-label" id="mcp-endpoint-heading">Your library address</div>
            <div className="mcp-endpoint-row">
              <code className="mcp-endpoint">{endpoint}</code>
              <CopyButton target="endpoint" value={endpoint} copied={copied} onCopy={copy} />
              <div className="mcp-endpoint-meta">
                <span>Streamable HTTP</span>
              </div>
            </div>
          </section>

          <div className="mcp-connect-grid">
            <section className="mcp-card" aria-labelledby="mcp-connect-heading">
              <div className="mcp-card-heading">
                <div>
                  
                  <h2 id="mcp-connect-heading">Connect</h2>
                </div>
              </div>

              <div className="mcp-step">
                
                <div className="mcp-step-content">
                  <h3>Client</h3>
                  <div className="mcp-client-list" role="tablist" aria-label="MCP clients">
                    {MCP_CLIENTS.map((client) => {
                      const active = selectedClient === client.id;
                      return (
                        <button
                          key={client.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setSelectedClient(client.id)}
                          className={`mcp-client-button${active ? " is-active" : ""}`}
                        >
                          {client.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="mcp-step">
                
                <div className="mcp-step-content">
                  <div className="mcp-auth-options" aria-label="Connection method">
                    <button aria-pressed={mode === "oauth"} onClick={() => setMode("oauth")}><strong>Sign in with OAuth</strong><span>Recommended</span></button>
                    <button aria-pressed={mode === "key"} onClick={() => setMode("key")}><strong>Use an API key</strong><span>For scripts and CLI tools</span></button>
                  </div>
                  <p className="mcp-step-copy">{mode === "oauth" ? "Add this to your client, then approve access in your browser. In Claude Desktop or claude.ai, add the address as a custom connector." : <>Create a key in <a href="/settings#connected-clients">Settings › Connected clients</a>, then replace <code>{MCP_TOKEN_PLACEHOLDER}</code>.</>}</p>
                  <div className="mcp-code-wrap">
                    <pre><code>{snippet}</code></pre>
                    <CopyButton target="snippet" value={snippet} copied={copied} onCopy={copy} />
                  </div>
                  <p className="mcp-note">Connections start read-only. Allow changes in Connected clients. Agents can never delete.</p>
                </div>
              </div>
            </section>

            <section className="mcp-card mcp-tools-card" aria-labelledby="mcp-tools-heading">
              <div className="mcp-card-heading">
                <div>
                  
                  <h2 id="mcp-tools-heading">Tools</h2>
                </div>
                <span className="mcp-tool-count" aria-label={`${MCP_TOOL_CATALOG.length + MCP_WRITE_TOOL_CATALOG.length} tools`}>{MCP_TOOL_CATALOG.length + MCP_WRITE_TOOL_CATALOG.length}</span>
              </div>
              <p className="mcp-tools-intro">Search matches by meaning when AI is on, by keyword otherwise.</p>
              <div className="mcp-tool-list">
                {[...MCP_TOOL_CATALOG, ...MCP_WRITE_TOOL_CATALOG].map((tool) => (
                  <div className="mcp-tool-row" key={tool.name}>
                    <code>{tool.name}</code>
                    <span>{tool.summary}{"permission" in tool && <em className="mcp-permission">Needs write permission</em>}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
