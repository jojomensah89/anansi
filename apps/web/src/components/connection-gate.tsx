import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "../lib/api.ts";

const sessionKey = ["auth", "session"] as const;

export function ConnectionGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const session = useQuery({
    queryKey: sessionKey,
    queryFn: ({ signal }) => api.session(signal),
    retry: 1,
    staleTime: 30_000,
  });
  const connect = useMutation({
    mutationFn: () => api.connect(token),
    onSuccess: (next) => {
      queryClient.setQueryData(sessionKey, next);
      setToken("");
    },
  });

  if (session.isPending) {
    return <GateFrame><span role="status" aria-label="Loading" style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)" }} /> </GateFrame>;
  }

  if (session.isError) {
    return (
      <GateFrame>
        <h1 style={titleStyle}>Anansi is out of reach</h1>
        <p style={copyStyle}>{message(session.error)}</p>
        <button type="button" onClick={() => void session.refetch()} style={primaryStyle}>
          Try again
        </button>
      </GateFrame>
    );
  }

  if (session.data.authenticated) return children;

  if (!session.data.configured) {
    return (
      <GateFrame>
        <h1 style={titleStyle}>Library access is not configured</h1>
        <p style={copyStyle}>
          Set <span className="mono">LIBRARY_TOKEN</span> on this Anansi server, then reload this page.
        </p>
      </GateFrame>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) connect.mutate();
  };

  return (
    <GateFrame>
      <div aria-hidden="true" style={{ width: 42, height: 42, borderRadius: 12, background: "var(--accent)", color: "var(--ink)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 18 }}>A</div>
      <h1 style={titleStyle}>Connect to your library</h1>
      <p style={copyStyle}>
        Enter the <span className="mono">LIBRARY_TOKEN</span> configured on this Anansi instance. It is exchanged for a secure browser session and is not stored in the page.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
        <label htmlFor="library-token" style={{ fontSize: 12, color: "var(--muted)" }}>Library token</label>
        <input
          id="library-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={connect.isPending}
          autoFocus
          style={{ height: 40, borderRadius: 6, border: "1px solid var(--edge-strong)", background: "var(--card)", color: "var(--text)", padding: "0 12px", fontFamily: "var(--mono)", outline: "none" }}
        />
        {connect.isError && <div role="alert" style={{ color: "#f2a7a7", fontSize: 12 }}>{message(connect.error)}</div>}
        <button type="submit" disabled={!token.trim() || connect.isPending} style={{ ...primaryStyle, opacity: !token.trim() || connect.isPending ? 0.55 : 1 }}>
          {connect.isPending ? "Connecting…" : "Connect"}
        </button>
      </form>
    </GateFrame>
  );
}

function GateFrame({ children }: { children: ReactNode }) {
  return (
    <main style={{ minHeight: "100svh", display: "grid", placeItems: "center", padding: 24, background: "var(--ink)" }}>
      <section style={{ width: 420, maxWidth: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 14, padding: 26, border: "1px solid var(--line)", borderRadius: 10, background: "var(--card)" }}>
        {children}
      </section>
    </main>
  );
}

const titleStyle = { fontSize: 20, margin: 0, color: "var(--text)" } as const;
const copyStyle = { fontSize: 13, lineHeight: 1.6, margin: 0, color: "var(--muted)" } as const;
const primaryStyle = { minHeight: 38, border: "none", borderRadius: 6, padding: "0 14px", background: "var(--accent)", color: "var(--ink)", cursor: "pointer", font: "inherit", fontWeight: 600 } as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}
