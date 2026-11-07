import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { libraryFreshnessOptions } from "../lib/library-query.ts";

function extensionSync(): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (ok: boolean) => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(ok);
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.anansi === "library-sync-response" &&
        event.data.id === id
      )
        done(event.data.ok === true);
    };
    const timer = setTimeout(() => done(false), 2000);
    window.addEventListener("message", receive);
    window.postMessage({ anansi: "library-sync-request", id }, location.origin);
  });
}
export function SyncControls({ settings = false }: { settings?: boolean }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const health = useQuery({
    queryKey: ["sync-health"],
    queryFn: () => api.sources(),
    ...libraryFreshnessOptions,
  });
  const config = useQuery({
    queryKey: ["sync-settings"],
    queryFn: async () => {
      const response = await fetch("/api/sync/settings");
      if (!response.ok) throw new Error("Could not load sync settings");
      return response.json() as Promise<{
        agentTabs: boolean;
        githubUsername: string | null;
        githubCheckedAt: number | null;
        githubError: string | null;
      }>;
    },
    ...libraryFreshnessOptions,
  });
  async function save(value: {
    agentTabs: boolean;
    githubUsername: string | null;
  }) {
    try {
      const response = await fetch("/api/sync/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      setMessage(
        response.ok ? "Sync settings saved" : "Could not save sync settings",
      );
      await config.refetch();
    } catch {
      setMessage("Could not save sync settings");
    }
  }
  if (settings)
    return (
      <section id="sync" className="anansi-settings-section sync-settings">
        <h2 className="anansi-settings-heading">Sync</h2>
        {config.isPending ? (
          <p>Loading sync settings...</p>
        ) : config.isError ? (
          <p role="alert">
            Could not load sync settings{" "}
            <button onClick={() => void config.refetch()}>Try again</button>
          </p>
        ) : (
          config.data && (
            <form
              className="anansi-settings-list"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const username = String(
                  data.get("githubUsername") ?? "",
                ).trim();
                if (
                  username &&
                  !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(
                    username,
                  )
                ) {
                  setMessage(
                    "Enter a valid GitHub username, without @ or a URL",
                  );
                  return;
                }
                void save({
                  agentTabs: config.data!.agentTabs,
                  githubUsername: username || null,
                });
              }}
            >
              <div className="anansi-settings-row">
                <div className="anansi-settings-copy">
                  <strong>Let agents check X and TikTok</strong>
                  <p>
                    Checks may open browser tabs. TikTok also needs permission
                    in the extension.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Let agents check X and TikTok"
                  aria-checked={config.data.agentTabs}
                  className="anansi-settings-toggle"
                  data-state={config.data.agentTabs ? "on" : "off"}
                  onClick={() =>
                    void save({
                      agentTabs: !config.data!.agentTabs,
                      githubUsername: config.data!.githubUsername,
                    })
                  }
                >
                  <span />
                </button>
              </div>
              <div className="anansi-settings-row sync-username"><div className="anansi-settings-copy">
                <label htmlFor="github-username">Public GitHub username</label>
                <input
                  id="github-username"
                  name="githubUsername"
                  defaultValue={config.data.githubUsername ?? ""}
                  maxLength={39}
                />
                <button type="submit">Save username</button>
                <p>
                  Public stars:{" "}
                  {config.data.githubCheckedAt
                    ? `checked ${new Date(config.data.githubCheckedAt * 1000).toLocaleString()}`
                    : "not checked yet"}
                  {config.data.githubError
                    ? "; could not check stars. Try again later."
                    : ""}
                </p>
              </div></div>
            </form>
          )
        )}
        <p role="status">{message}</p>
      </section>
    );
  return (
    <div className="sync-toolbar">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const reachable = await extensionSync();
            await api.requestSync(true, reachable);
            setMessage(
              reachable
                ? "Sync requested"
                : "Extension unreachable; queued for next check-in",
            );
          } catch {
            setMessage("Could not request sync; try again");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Requesting..." : "Sync now"}
      </button>
      <span>
        {health.data?.extension.connection === "connected"
          ? "Browser online"
          : health.data
            ? "Browser offline"
            : "Checking browser..."}
      </span>
      <span role="status" className="sync-feedback">
        {message}
      </span>
    </div>
  );
}
