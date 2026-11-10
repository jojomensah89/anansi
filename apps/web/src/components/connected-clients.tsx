import {ClientWritePermission} from "./client-write-permission.tsx";
import { useEffect, useRef, useState } from "react";
import { pairingState, dismissPairing } from "../lib/pairing-state.ts";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@anansi/ui/components/button";
import { Input } from "@anansi/ui/components/input";
type Client = {
  id: string;
  name: string;
  kind: string;
  scopes: string;
  lastUse: number | null;
  revokedAt: number | null;
};
async function call(path = "", method = "GET", body?: unknown) {
  const response = await fetch(`/api/clients${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error("Could not update connected clients");
  return response.json() as Promise<{
    id: string;
    clients: Client[];
    legacyActive: boolean;
    key: string;
  }>;
}
function trail(c: Client) {
  if (!c.lastUse) return "Never used";
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - c.lastUse) / 60));
  const time =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)} hr ago`
          : minutes < 2880
            ? "yesterday"
            : `${Math.floor(minutes / 1440)} days ago`;
  return `Used ${time}`;
}
function connectBridge(code: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (ok: boolean) => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(ok);
    };
    const receive = (e: MessageEvent) => {
      if (
        e.source === window &&
        e.origin === location.origin &&
        e.data?.anansi === "library-connect-response" &&
        e.data.id === id
      )
        done(e.data.ok === true);
    };
    const timer = setTimeout(() => done(false), 3000);
    window.addEventListener("message", receive);
    window.postMessage(
      { anansi: "library-connect-request", id, code },
      location.origin,
    );
  });
}
function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      onClick={() =>
        void navigator.clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
export function ConnectedClients() {
  const router = useRouter();
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [notice, setNotice] = useState("");
  const [data, setData] = useState<{
      clients: Client[];
      legacyActive: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(""),
    [flow, setFlow] = useState<"api" | "extension" | null>(null),
    [reveal, setReveal] = useState<{ key: string; pairing: boolean; id?: string } | null>(
      null,
    ),
    [seconds, setSeconds] = useState(300),
    [confirm, setConfirm] = useState<Client | "old" | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState("");
  const expiresAt = useRef(0);
  const gate = useRef(false);
  const revealRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    revealRef.current?.focus({ preventScroll: true });
    revealRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [reveal]);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setConfirm(null);
      if (event.key !== "Tab" || !dialog) return;
      const buttons = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );
      const first = buttons[0],
        last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [confirm, busy]);
  const refresh = async () => setData(await call());
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!reveal?.pairing || seconds === 0) return;
    const timer = setInterval(
      () => setSeconds(Math.max(0, Math.ceil((expiresAt.current - Date.now()) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [reveal, seconds === 0]);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  useEffect(() => {
    if (!reveal?.pairing || seconds === 0) return;
    let cancelled = false;
    const check = async () => {
      try {
        const result = await call();
        const state = pairingState(result.clients,reveal.id,seconds);
        if (!cancelled && state === "redeemed") {
          setReveal(null);
          setData(result);
          setNotice("Extension connected");
          window.dispatchEvent(new Event("anansi-connection-updated"));
          void router.invalidate();
        }
      } catch { /* Retry while the code is still usable. */ }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [reveal, seconds === 0, router]);
  async function action(work: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  const clients = data?.clients.filter((c) => c.kind !== "pairing") ?? [];
  const active = clients.filter((c) => c.revokedAt === null),
    revoked = clients.filter((c) => c.revokedAt !== null);
  function row(c: Client) {
    return (
      <tr key={c.id}>
        <td>
          {editing === c.id ? (
            <form
              className="client-actions"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await call(`/${c.id}`, "PATCH", { name: draft });
                  setEditing(null);
                });
              }}
            >
              <Input
                autoFocus
                aria-label="Client name"
                maxLength={100}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button type="submit" disabled={busy || !draft.trim()}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <strong>{c.name}</strong>
          )}
        </td>
        <td>{c.kind === "api" ? "API key" : c.kind === "app" ? "App" : "Extension"}</td>
        <td><span>{c.kind === "api" || c.kind === "app" ? "Read library" : "Save only"}</span><ClientWritePermission client={c} onChange={() => void refresh().catch(e => setError(e.message))} /></td>
        <td>{trail(c)}</td>
        <td>
          <div className="client-actions">
            {c.revokedAt !== null ? (
              "Revoked"
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(c.id);
                    setDraft(c.name);
                  }}
                >
                  Rename
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(c)}>
                  Revoke
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }
  return (
    <section
      id="connected-clients"
      className="anansi-settings-section clients-section"
    >
      <div className="client-section-head">
        <h2 className="anansi-settings-heading">Connected clients</h2>
        <div className="client-actions">
        <Button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              // Only one code is ever live.
              if (reveal) await dismissPairing(reveal, (id) => call(`/${id}`, "DELETE"));
              setReveal(null);
              setFlow(null);
              setNotice("");
              const issued = await call("", "POST", {kind:"pairing",name:"Browser extension"});
              expiresAt.current = Date.now() + 300000; setSeconds(300);
              setReveal({key:issued.key,pairing:true,id:issued.id});
              await connectBridge(issued.key);

            })
          }
        >
          Connect extension
        </Button>

        <Button
          variant="outline"
          onClick={() => {
            setFlow("api");
            setName("");
          }}
        >
          Create API key
        </Button>
        </div>
      </div>
      {flow && (
        <form
          className="client-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const result = await call("", "POST", { kind: flow, name });
              setReveal({ key: result.key, pairing: false });
              setFlow(null);
              setName("");
            });
          }}
        >
          <h3>{flow === "api" ? "Create API key" : "Create capture key"}</h3>
          <p>
            {flow === "api"
              ? "Read-only until you allow changes"
              : "Save-only, for connecting the extension by hand"}
          </p>
          <label htmlFor="new-client-name">Name</label>
          <Input
            id="new-client-name"
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Research assistant"
          />
          <div className="client-actions">
            <Button type="submit" disabled={busy || !name.trim()}>
              Create key
            </Button>
            <Button type="button" variant="ghost" onClick={() => setFlow(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {reveal && (
        <div
          ref={revealRef}
          tabIndex={-1}
          className="client-panel client-reveal"
          role="region"
          aria-label={reveal.pairing ? "Connect extension" : "Your new key"}
        >
          <h3>
            {reveal.pairing ? "Connect your extension" : "Copy your key now"}
          </h3>
          <p>
            {reveal.pairing
              ? seconds === 0 ? "This code has expired" : `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
              : "Shown once. Store it somewhere safe"}
          </p>
          {!reveal.pairing || seconds > 0 ? (
            <>
              <div className="client-code"><code>{reveal.key}</code><Copy value={reveal.key} /></div>
            </>
          ) : (
            <><Button onClick={() => void action(async () => {
              const issued = await call("", "POST", {kind:"pairing",name:"Browser extension"});
              expiresAt.current = Date.now() + 300000; setSeconds(300); setReveal({key:issued.key,pairing:true,id:issued.id});
            })}>Get a new code</Button></>
          )}
          {reveal.pairing && seconds > 0 && (
            <>
              <ol>
                <li>Open the Anansi extension</li>
                <li>Paste this site's address and the code
                  <div className="client-address"><span>{location.origin}</span><Copy value={location.origin} /></div>
                </li>
                <li>Approve access to this site</li>
              </ol>
            </>
          )}
          <Button variant="ghost" onClick={() => void action(async () => {
            await dismissPairing(reveal,id => call(`/${id}`, "DELETE"));
            setReveal(null);
          })}>
            Dismiss
          </Button>
        </div>
      )}
      {notice && <p ref={noticeRef} tabIndex={-1} className="client-panel" role="status">{notice}</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <Button variant="ghost" onClick={() => void action(async () => {})}>
            Try again
          </Button>
        </p>
      )}
      {!data ? (
        error ? null : (
          <p role="status">Loading clients…</p>
        )
      ) : (
        <>
          {active.length === 0 && !data.legacyActive && (
            <div className="client-empty">
              <h3>No connected clients</h3>
              <p>Connect the extension to save from your browser, or create an API key</p>
            </div>
          )}
          <div className="client-table-wrap">
            <table className="client-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Access</th>
                  <th>Last used</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map(row)}
                {data.legacyActive && (
                  <tr>
                    <td>
                      <strong>Old shared token</strong>
                    </td>
                    <td>Shared token</td>
                    <td>Read and save</td>
                    <td>&mdash;</td>
                    <td>
                      <Button
                        variant="destructive"
                        onClick={() => setConfirm("old")}
                      >
                        Retire token
                      </Button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {revoked.length > 0 && (
            <details className="client-disclosure">
              <summary>{revoked.length} revoked</summary>
              <div className="client-table-wrap">
                <table className="client-table">
                  <tbody>{revoked.map(row)}</tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
      <details className="client-disclosure">
        <summary>Manual capture key</summary>
        <Button
          variant="outline"
          onClick={() => {
            setFlow("extension");
            setName("");
          }}
        >
          Create a capture key
        </Button>
      </details>
      {confirm && (
        <div className="client-modal-backdrop">
          <div
            className="client-panel client-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="revoke-title"
            aria-describedby="revoke-description"
          >
            <h3 id="revoke-title">
              {confirm === "old"
                ? "Retire old shared token?"
                : `Revoke ${confirm.name}?`}
            </h3>
            <p id="revoke-description">
              {confirm === "old"
                ? "Every extension and script using it stops working. Reconnect extensions and replace script keys first. Your own sign-in keeps working."
                : "It loses access right away. Your saves stay."}
            </p>
            <div className="client-actions">
              <Button
                autoFocus
                variant="outline"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Keep access
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await call(
                      confirm === "old" ? "/retire-legacy" : `/${confirm.id}`,
                      confirm === "old" ? "POST" : "DELETE",
                    );
                    setConfirm(null);
                  })
                }
              >
                {busy
                  ? "Removing…"
                  : confirm === "old"
                    ? "Retire token"
                    : "Revoke access"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
