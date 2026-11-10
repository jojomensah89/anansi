import { Button } from "@anansi/ui/components/button";
import { Input } from "@anansi/ui/components/input";
import { Label } from "@anansi/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RotateCcw } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "../lib/api.ts";
import { PageSkeleton } from "./skeleton.tsx";

const sessionKey = ["auth", "session"] as const;
const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;

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
    return <PageSkeleton />;
  }

  if (session.isError) {
    return (
      <AuthCard size="sm" title="Anansi is out of reach">
        <p className="auth-lead">{message(session.error)}</p>
        <div>
          <Button variant="outline" onClick={() => void session.refetch()} disabled={session.isFetching}>
            <RotateCcw {...ICON} />
            {session.isFetching ? "Trying" : "Try again"}
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (session.data.authenticated) return children;

  if (!session.data.configured) {
    return (
      <AuthCard size="sm" title="Sign-in isn’t set up">
        <p className="auth-lead">
          Set <code>LIBRARY_TOKEN</code> or <code>ANANSI_SECRET</code> on the server, then reload
        </p>
      </AuthCard>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) connect.mutate();
  };
  const failed = connect.isError;

  return (
    <AuthCard title="Sign in to Anansi" lead="Paste your library token">
      <form onSubmit={submit} className="auth-form">
        <div className="auth-field">
          <Label htmlFor="library-token">Token</Label>
          <Input
            id="library-token"
            type="password"
            autoComplete="current-password"
            className="auth-input auth-mono"
            value={token}
            aria-invalid={failed || undefined}
            aria-describedby="library-token-hint"
            onChange={(event) => setToken(event.target.value)}
            disabled={connect.isPending}
          />
          {failed ? (
            <span id="library-token-hint" role="alert" className="auth-error">
              <AlertCircle {...ICON} />
              {tokenError(connect.error)}
            </span>
          ) : (
            <span id="library-token-hint" className="auth-meta">
              Your <code>LIBRARY_TOKEN</code>, or <code>ANANSI_SECRET</code> if none is set
            </span>
          )}
        </div>
        <Button type="submit" className="auth-submit" disabled={!token.trim() || connect.isPending}>
          {connect.isPending ? "Connecting" : "Connect"}
        </Button>
      </form>
    </AuthCard>
  );
}

/** The centred card shared by sign-in and app consent: the spider, a title, then the content. */
export function AuthCard({
  title,
  lead,
  size = "md",
  logo,
  children,
}: {
  title: ReactNode;
  lead?: ReactNode;
  size?: "sm" | "md" | "lg";
  logo?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-card" data-size={size} aria-labelledby="auth-title">
        {logo ?? <AnansiMark />}
        <div className="auth-head">
          <h1 id="auth-title">{title}</h1>
          {lead && <p className="auth-lead">{lead}</p>}
        </div>
        {children}
      </section>
    </main>
  );
}

export function AnansiMark() {
  return <img className="auth-logo" src="/favicon.png" width={32} height={32} alt="Anansi" />;
}

function tokenError(error: unknown): string {
  const text = message(error);
  return text === "unauthorized" ? "That token didn’t work" : text.charAt(0).toUpperCase() + text.slice(1);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}
