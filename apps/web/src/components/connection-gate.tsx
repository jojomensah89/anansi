import { Button } from "@anansi/ui/components/button";
import { Input } from "@anansi/ui/components/input";
import { Label } from "@anansi/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RotateCcw } from "lucide-react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { addPasskey, passkeyError, sessionKey, signInWithPasskey } from "../lib/passkey.ts";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;

export function ConnectionGate({ children }: { children: ReactNode }) {
  const session = useQuery({
    queryKey: sessionKey,
    queryFn: ({ signal }) => api.session(signal),
    retry: 1,
    staleTime: 30_000,
  });

  // The session answers from the same origin in a few milliseconds, and the page
  // draws its own placeholders once it mounts, so there is nothing to show here.
  if (session.isPending) return null;

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

  return session.data.hasPasskey ? <PasskeySignIn /> : <ClaimLibrary />;
}

/** No passkey yet: the deploy secret creates the first one, once. */
function ClaimLibrary() {
  const queryClient = useQueryClient();
  const supported = usePasskeySupport();
  const [secret, setSecret] = useState("");
  const claim = useMutation({
    mutationFn: async () => {
      await addPasskey(secret);
      return api.session();
    },
    onSuccess: (next) => queryClient.setQueryData(sessionKey, next),
  });
  const error = claim.isError ? passkeyError(claim.error) : null;

  // A browser without passkeys can still open the library with the secret.
  if (supported === false) return <SecretSignIn />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (secret.trim() && !claim.isPending) claim.mutate();
  };

  return (
    <AuthCard title="Secure your library" lead="Create a passkey to sign in from now on">
      <form onSubmit={submit} className="auth-form">
        <SecretField
          id="deploy-secret"
          label="Deploy secret"
          value={secret}
          onChange={setSecret}
          disabled={claim.isPending}
          autoFocus
          error={error}
          hint={<>Your <code>LIBRARY_TOKEN</code> or <code>ANANSI_SECRET</code>. It stays your recovery key</>}
        />
        <Button type="submit" className="auth-submit" disabled={!secret.trim() || claim.isPending}>
          {claim.isPending ? "Waiting for passkey" : "Create passkey"}
        </Button>
      </form>
    </AuthCard>
  );
}

/** The daily sign-in: one button, then the browser's passkey prompt. */
function PasskeySignIn() {
  const queryClient = useQueryClient();
  const supported = usePasskeySupport();
  const [recovery, setRecovery] = useState(false);
  const signIn = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: (next) => queryClient.setQueryData(sessionKey, next),
  });
  const error = signIn.isError ? passkeyError(signIn.error) : null;

  if (recovery || supported === false) {
    return <SecretSignIn onBack={supported === false ? undefined : () => setRecovery(false)} />;
  }

  return (
    <AuthCard title="Sign in to Anansi">
      <div className="auth-form">
        <div className="auth-field">
          <Button
            className="auth-submit"
            autoFocus
            disabled={signIn.isPending}
            onClick={() => signIn.mutate()}
            aria-describedby={error ? "passkey-error" : undefined}
          >
            {signIn.isPending ? "Waiting for passkey" : "Sign in with passkey"}
          </Button>
          {error && (
            <span id="passkey-error" role="alert" className="auth-error">
              <AlertCircle {...ICON} />
              {error}
            </span>
          )}
        </div>
        <Button variant="link" className="auth-switch" onClick={() => setRecovery(true)}>
          Use recovery secret
        </Button>
      </div>
    </AuthCard>
  );
}

/** Recovery: the deploy secret opens a session; a new passkey is added in Settings. */
function SecretSignIn({ onBack }: { onBack?: () => void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const connect = useMutation({
    mutationFn: () => api.connect(token),
    onSuccess: (next) => {
      queryClient.setQueryData(sessionKey, next);
      setToken("");
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) connect.mutate();
  };

  return (
    <AuthCard title="Sign in to Anansi">
      <form onSubmit={submit} className="auth-form">
        <SecretField
          id="library-token"
          label="Recovery secret"
          value={token}
          onChange={setToken}
          disabled={connect.isPending}
          autoFocus
          error={connect.isError ? passkeyError(connect.error) : null}
          hint={<>Your <code>LIBRARY_TOKEN</code>, or <code>ANANSI_SECRET</code> if none is set</>}
        />
        <Button type="submit" className="auth-submit" disabled={!token.trim() || connect.isPending}>
          {connect.isPending ? "Signing in" : "Sign in"}
        </Button>
        {onBack && (
          <Button type="button" variant="link" className="auth-switch" onClick={onBack}>
            Use passkey
          </Button>
        )}
      </form>
    </AuthCard>
  );
}

function SecretField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoFocus,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
  error: string | null;
  hint: ReactNode;
}) {
  return (
    <div className="auth-field">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        autoComplete="current-password"
        autoFocus={autoFocus}
        className="auth-input auth-mono"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
      {error ? (
        <span id={`${id}-hint`} role="alert" className="auth-error">
          <AlertCircle {...ICON} />
          {error}
        </span>
      ) : (
        <span id={`${id}-hint`} className="auth-meta">{hint}</span>
      )}
    </div>
  );
}

/** null until checked on the client, then whether this browser can use passkeys at all. */
function usePasskeySupport(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  return supported;
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}
