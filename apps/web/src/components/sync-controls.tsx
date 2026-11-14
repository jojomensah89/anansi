import { Button } from "@anansi/ui/components/button";
import { Input } from "@anansi/ui/components/input";
import { Switch } from "@anansi/ui/components/switch";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.ts";
import { requestExtensionSync } from "../lib/extension-bridge.ts";
import { expectIncomingSaves, libraryKeys } from "../lib/library-query.ts";
import { checkedLabel, SettingsRow } from "./settings-panel.tsx";
import { SettingsSkeleton } from "./skeleton.tsx";
import { SourceMark } from "./sourcemark.tsx";

type SyncConfig = {
	agentTabs: boolean;
	githubUsername: string | null;
	githubCheckedAt: number | null;
	githubError: string | null;
};

const GITHUB_USERNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/** The library toolbar's Sync now button. */
export function SyncControls() {
	const [busy, setBusy] = useState(false);
	const queryClient = useQueryClient();
	return (
		<div className="sync-toolbar">
			<Button
				variant="outline"
				className="toolbar-button"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					try {
						const reachable = await requestExtensionSync();
						await api.requestSync(true, reachable);
						expectIncomingSaves();
						void queryClient.invalidateQueries({ queryKey: libraryKeys.stats() });
						if (reachable) toast.success("Sync requested");
						else toast("Extension offline", { description: "It syncs on its next check-in" });
					} catch (error) {
						toast.error("Sync failed", { description: error instanceof Error && error.message ? error.message : undefined });
					} finally {
						setBusy(false);
					}
				}}
			>
				<RefreshCw aria-hidden="true" strokeWidth={1.5} />
				<span className="toolbar-button-label">{busy ? "Syncing" : "Sync now"}</span>
			</Button>
		</div>
	);
}

/** Settings › Sync: agent checks and the public GitHub username. */
export function SyncSettings() {
	/** Only the username field's own validation shows on the page; saves answer with a toast. */
	const [invalid, setInvalid] = useState<string | null>(null);
	const config = useQuery({
		queryKey: ["sync-settings"],
		queryFn: async () => {
			const response = await fetch("/api/sync/settings");
			if (!response.ok) throw new Error("Could not load sync settings");
			return response.json() as Promise<SyncConfig>;
		},
		retry: 1,
	});
	async function save(value: { agentTabs: boolean; githubUsername: string | null }, confirm?: string) {
		try {
			const response = await fetch("/api/sync/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(value),
			});
			if (!response.ok) toast.error("Couldn't save sync settings", { description: `${response.status} ${response.statusText}`.trim() });
			else if (confirm) toast.success(confirm);
			await config.refetch();
		} catch (error) {
			toast.error("Couldn't save sync settings", { description: error instanceof Error && error.message ? error.message : undefined });
		}
	}
	if (config.isPending) return <SettingsSkeleton label="Loading sync settings" />;
	if (config.isError || !config.data)
		return (
			<SettingsRow
				title="Sync"
				description={<span role="alert">Couldn't load sync settings</span>}
				control={
					<Button variant="outline" onClick={() => void config.refetch()}>
						<RotateCcw aria-hidden="true" strokeWidth={1.5} />
						Try again
					</Button>
				}
			/>
		);
	const data = config.data;
	const checked = data.githubCheckedAt ? `Checked ${checkedLabel(data.githubCheckedAt)}` : "Not checked yet";
	return (
		<>
			<SettingsRow
				title="Let agents check X and TikTok"
				description="May open browser tabs. TikTok also needs permission in the extension"
				control={
					<Switch
						aria-label="Let agents check X and TikTok"
						checked={data.agentTabs}
						onCheckedChange={(next) => void save({ agentTabs: next, githubUsername: data.githubUsername })}
					/>
				}
			/>
			<SettingsRow
				icon={<SourceMark source="github" size={16} decorative />}
				title="Public GitHub stars"
				description={
					<>
						{checked}
						{data.githubError && <span className="settings-inline-warn"> · last check failed</span>}
					</>
				}
				control={
					<form
						className="settings-joined settings-github"
						onSubmit={(event) => {
							event.preventDefault();
							const username = String(new FormData(event.currentTarget).get("githubUsername") ?? "").trim();
							if (username && !GITHUB_USERNAME.test(username)) {
								setInvalid("Enter a GitHub username, without @ or a link");
								return;
							}
							setInvalid(null);
							void save({ agentTabs: data.agentTabs, githubUsername: username || null }, username ? "GitHub username saved" : "GitHub username cleared");
						}}
					>
						<Input
							id="github-username"
							name="githubUsername"
							aria-label="GitHub username"
							placeholder="username"
							defaultValue={data.githubUsername ?? ""}
							maxLength={39}
							autoComplete="off"
							spellCheck={false}
							aria-invalid={invalid ? true : undefined}
							aria-describedby={invalid ? "github-username-error" : undefined}
							onChange={() => setInvalid(null)}
						/>
						<Button variant="outline" type="submit" aria-label="Save GitHub username">
							Save
						</Button>
					</form>
				}
			>
				{invalid && (
					<p id="github-username-error" role="alert" className="settings-message" data-tone="danger">
						{invalid}
					</p>
				)}
			</SettingsRow>
		</>
	);
}
