import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { libraryFreshnessOptions } from "../lib/library-query.ts";

const SOURCE_NAMES = { x: "X", reddit: "Reddit", github: "GitHub", tiktok: "TikTok" } as const;

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
	return (
		<section aria-label="Platform sync" style={{ padding: "8px 16px", fontSize: 14, color: "var(--muted)" }}>
			<button
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					try {
						const reachable = await extensionSync();
						// Worker public stars also work without a connected browser. Avoid a second forced browser run.
						await api.requestSync(true, reachable);
						setMessage(
							reachable
								? "Browser sync requested"
								: "Extension not reachable here. Request queued for its next check-in; public GitHub check requested.",
						);
					} catch {
						setMessage("Sync request failed");
					} finally {
						setBusy(false);
					}
				}}
			>
				{busy ? "Requesting…" : "Sync now"}
			</button>
			<span role="status" style={{ marginLeft: 10 }}>
				{message ? `${message} · ` : ""}
				{health.data
					? health.data.extension.connection === "connected"
						? "Browser online"
						: "Browser offline"
					: "Browser status unavailable"}
			</span>
			<details style={{ marginTop: 4 }}>
				<summary style={{ cursor: "pointer" }}>Platform checks</summary>
				<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
					{(["x", "reddit", "github", "tiktok"] as const).map((source) => {
						const state = health.data?.extension.sources[source];
						return (
							<li key={source}>
								{SOURCE_NAMES[source]}: last check{" "}
								{state?.lastCheckedAt
									? new Date(state.lastCheckedAt * 1000).toLocaleString()
									: "not yet"}
								{state?.lastErrorCode ? ` · ${state.lastErrorCode.replaceAll("_", " ")}` : ""}
								{source === "github" && config.data
									? ` · public stars ${config.data.githubCheckedAt ? new Date(config.data.githubCheckedAt * 1000).toLocaleString() : "not checked"}${config.data.githubError ? ` (${config.data.githubError.replaceAll("_", " ")})` : ""}`
									: ""}
							</li>
						);
					})}
				</ul>
			</details>
			{settings && config.data && (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						const data = new FormData(event.currentTarget);
						void save({
							agentTabs: data.get("agentTabs") === "on",
							githubUsername:
								String(data.get("githubUsername") ?? "").trim() || null,
						});
					}}
				>
					<label>
						<input
							name="agentTabs"
							type="checkbox"
							defaultChecked={config.data.agentTabs}
						/>{" "}
						Let agents check X and TikTok
					</label>
					<p>
						These checks can open a tab or a visible TikTok window. TikTok also
						requires opt-in in the extension.
					</p>
					<label>
						Public GitHub username{" "}
						<input
							name="githubUsername"
							defaultValue={config.data.githubUsername ?? ""}
							maxLength={39}
						/>
					</label>
					<button type="submit">Save sync settings</button>
				</form>
			)}
		</section>
	);
}
