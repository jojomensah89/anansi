import { useEffect, useMemo, useState } from "react";
import { MCP_TOOL_CATALOG } from "@anansi/mcp/catalog";
import { Rail } from "./rail.tsx";
import { clientSnippet, MCP_CLIENTS, MCP_TOKEN_PLACEHOLDER, type McpClientId } from "./mcp-config.ts";
import { api } from "../lib/api.ts";

type CopyTarget = "endpoint" | "snippet";

function ServerGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
    </svg>
  );
}

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

function ClientGlyph({ glyph }: { glyph: string }) {
  return (
    <span className="mcp-client-glyph" aria-hidden="true">
      {glyph}
    </span>
  );
}

export function McpServerPage() {
  const [origin, setOrigin] = useState("");
  const [selectedClient, setSelectedClient] = useState<McpClientId>("claude-code");
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [stats, setStats] = useState({ items: 0, authors: 0, archived: 0, bySource: {} as Record<string, number> });

  // Keep the first render stable for SSR. The browser origin is public, but it
  // does not exist while the server is rendering the route.
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .stats(controller.signal)
      .then((next) => setStats({ items: next.items, authors: next.authors, archived: next.archived, bySource: next.bySource }))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const endpoint = `${origin}/mcp`;
  const snippet = useMemo(() => clientSnippet(selectedClient, endpoint), [endpoint, selectedClient]);

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
      <Rail total={stats.items} authors={stats.authors} archived={stats.archived} bySource={stats.bySource} />

      <main className="mcp-main scroll">
        <div className="mcp-wrap">
          <header className="mcp-header">
            <div className="mcp-eyebrow mono">
              <ServerGlyph size={15} />
              Integrations
            </div>
            <h1>MCP server</h1>
            <p>
              Give your agents a secure, read-only way to search the memories you have saved in Anansi.
            </p>
          </header>

          <section className="mcp-endpoint-card" aria-labelledby="mcp-endpoint-heading">
            <div className="mcp-card-label mono" id="mcp-endpoint-heading">Your MCP endpoint</div>
            <div className="mcp-endpoint-row">
              <code className="mcp-endpoint">{endpoint}</code>
              <CopyButton target="endpoint" value={endpoint} copied={copied} onCopy={copy} />
              <div className="mcp-endpoint-meta">
                <span className="mcp-status-pill"><span className="mcp-status-dot" />{MCP_TOOL_CATALOG.length} tools available</span>
                <span>Streamable HTTP · Bearer-key auth</span>
              </div>
            </div>
          </section>

          <div className="mcp-connect-grid">
            <section className="mcp-card" aria-labelledby="mcp-connect-heading">
              <div className="mcp-card-heading">
                <div>
                  <div className="mcp-card-kicker mono">Connect a client</div>
                  <h2 id="mcp-connect-heading">Add Anansi to your agent</h2>
                </div>
                <span className="mcp-step-count mono">01—02</span>
              </div>

              <div className="mcp-step">
                <span className="mcp-step-number">1</span>
                <div className="mcp-step-content">
                  <h3>Choose your client</h3>
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
                          <ClientGlyph glyph={client.glyph} />
                          {client.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="mcp-step">
                <span className="mcp-step-number">2</span>
                <div className="mcp-step-content">
                  <div className="mcp-step-title-row">
                    <h3>Use the configured token</h3>
                    <span className="mcp-configured"><span className="mcp-status-dot" />Configured</span>
                  </div>
                  <p className="mcp-step-copy">
                    Replace <code>{MCP_TOKEN_PLACEHOLDER}</code> with the <code>MCP_TOKEN</code> already configured on the Anansi server. It is never shown here.
                  </p>
                  <div className="mcp-code-wrap">
                    <pre><code>{snippet}</code></pre>
                    <CopyButton target="snippet" value={snippet} copied={copied} onCopy={copy} />
                  </div>
                  <p className="mcp-note mono">Bearer authentication is required for every MCP request.</p>
                </div>
              </div>
            </section>

            <section className="mcp-card mcp-tools-card" aria-labelledby="mcp-tools-heading">
              <div className="mcp-card-heading">
                <div>
                  <div className="mcp-card-kicker mono">Available tools</div>
                  <h2 id="mcp-tools-heading">Tools</h2>
                </div>
                <span className="mcp-tool-count mono">{MCP_TOOL_CATALOG.length}</span>
              </div>
              <p className="mcp-tools-intro">Read-only actions available to a connected agent.</p>
              <div className="mcp-tool-list">
                {MCP_TOOL_CATALOG.map((tool) => (
                  <div className="mcp-tool-row" key={tool.name}>
                    <code>{tool.name}</code>
                    <span>{tool.summary}</span>
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
