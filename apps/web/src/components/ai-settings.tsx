import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@anansi/ui/components/alert-dialog";
import { Badge } from "@anansi/ui/components/badge";
import { Button } from "@anansi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@anansi/ui/components/dialog";
import { Input } from "@anansi/ui/components/input";
import { Progress } from "@anansi/ui/components/progress";
import { Switch } from "@anansi/ui/components/switch";
import { Info, Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { api, type AiSettingsResponse } from "../lib/api.ts";
import { SettingsNotice, SettingsRow } from "./settings-panel.tsx";

type Preview = Awaited<ReturnType<typeof api.semanticPreview>>;
const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** "10,000" and "10000" both mean ten thousand. */
export function parseCap(draft: string): number | null {
	// Digits with any grouping separator a locale may have printed.
	if (!/^[\d.,'\s  ]+$/.test(draft.trim())) return null;
	const value = Number(draft.replace(/\D/g, ""));
	return Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : null;
}

/** Why indexing cannot start under this cap, or null when it can. */
export function capShortfall(preview: Preview, limit: number, used: number): string | null {
	const remaining = Math.max(0, limit - used);
	if (preview.runtime !== "cloudflare" || preview.estimate.estimatedCredits <= remaining) return null;
	return `Indexing needs ${preview.estimate.estimatedCredits.toLocaleString()} credits but only ${remaining.toLocaleString()} are left this month. Raise the cap or wait for the reset`;
}

export function useAiSettings() {
	const [data, setData] = useState<AiSettingsResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const load = () => {
		setLoadError(null);
		api.ai().then(setData).catch((e) => setLoadError(message(e, "Could not load AI settings")));
	};
	useEffect(load, []);
	return { data, setData, loadError, reload: load };
}

export function AiSettings({ data, setData }: { data: AiSettingsResponse; setData: Dispatch<SetStateAction<AiSettingsResponse | null>> }) {
	const [error, setError] = useState<string | null>(null);
	const [reclassifying, setReclassifying] = useState(false);
	const [watchingTagging, setWatchingTagging] = useState(data.settings.autoTaggingEnabled === 1 && data.taggingProgress.pending > 0);
	const [watchingSemantic, setWatchingSemantic] = useState(false);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [confirmOff, setConfirmOff] = useState(false);
	const [capDraft, setCapDraft] = useState(data.settings.semanticBudgetLimit.toLocaleString());
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!watchingSemantic) return;
		let stopped = false;
		let idlePolls = 0;
		let pollCount = 0;
		const timer = window.setInterval(() => {
			void api.ai().then((next) => {
				if (stopped) return;
				pollCount += 1;
				setData(next);
				if (next.semanticIndex.pending > 0 || next.embeddingProgress.pending > 0) idlePolls = 0;
				else idlePolls += 1;
				if ((pollCount >= 5 && idlePolls >= 3) || pollCount >= 60) setWatchingSemantic(false);
			}).catch((e) => {
				if (stopped) return;
				setError(message(e, "Could not refresh indexing progress"));
				setWatchingSemantic(false);
			});
		}, 2000);
		return () => { stopped = true; window.clearInterval(timer); };
	}, [watchingSemantic, setData]);

	useEffect(() => {
		if (!watchingTagging) return;
		let stopped = false;
		const timer = window.setInterval(() => {
			void api.ai().then((next) => {
				if (stopped) return;
				setData(next);
				if (next.taggingProgress.pending === 0) {
					setWatchingTagging(false);
					setReclassifying(false);
				}
			}).catch((e) => {
				if (stopped) return;
				setError(message(e, "Could not refresh tagging progress"));
				setWatchingTagging(false);
				setReclassifying(false);
			});
		}, 2000);
		return () => { stopped = true; window.clearInterval(timer); };
	}, [watchingTagging, setData]);

	const update = (key: "semanticSearchEnabled" | "autoTaggingEnabled", value: boolean) => {
		setData({ ...data, settings: { ...data.settings, [key]: value ? 1 : 0 } });
		if (key === "autoTaggingEnabled" && !value) {
			setWatchingTagging(false);
			setReclassifying(false);
		}
		api.updateAi({ [key]: value }).then((next) => {
			setData(next);
			setWatchingTagging(next.settings.autoTaggingEnabled === 1 && next.taggingProgress.pending > 0);
			if (key === "semanticSearchEnabled") setWatchingSemantic(value && next.settings.semanticIndexPaused !== 1);
		}).catch((e) => {
			setError(message(e, "Could not save settings"));
			void api.ai().then(setData).catch(() => undefined);
		});
	};

	const askToEnable = () => {
		setError(null);
		setPreviewError(null);
		setSaving(true);
		api.semanticPreview().then(setPreview).catch((e) => setError(message(e, "Could not estimate indexing"))).finally(() => setSaving(false));
	};

	const enableSemantic = async () => {
		if (!preview) return;
		const limit = parseCap(capDraft);
		if (limit === null) { setPreviewError("Enter a cap between 1 and 1,000,000"); return; }
		const shortfall = capShortfall(preview, limit, data.settings.semanticBudgetUsed);
		if (shortfall) { setPreviewError(shortfall); return; }
		setSaving(true);
		setPreviewError(null);
		try {
			const next = await api.updateAi({ semanticSearchEnabled: true, semanticBudgetLimit: limit, confirmSemanticBackfill: true });
			setData(next);
			setPreview(null);
			setWatchingSemantic(true);
		} catch (e) {
			setPreviewError(message(e, "Could not turn on search by meaning"));
		} finally { setSaving(false); }
	};

	const saveCap = async () => {
		const limit = parseCap(capDraft);
		if (limit === null) { setError("Enter a cap between 1 and 1,000,000"); return; }
		try {
			const next = await api.updateAi({ semanticBudgetLimit: limit });
			setData(next);
			setCapDraft(next.settings.semanticBudgetLimit.toLocaleString());
			setError(null);
		} catch (e) { setError(message(e, "Could not save the cap")); }
	};

	const setIndexPaused = async (paused: boolean) => {
		try {
			const next = await api.updateAi({ semanticIndexPaused: paused });
			setData(next);
			setWatchingSemantic(!paused && next.settings.semanticSearchEnabled === 1);
		} catch (e) { setError(message(e, "Could not update indexing")); }
	};

	const reclassify = async () => {
		setReclassifying(true);
		try {
			const next = await api.reclassifyAiTags();
			setData((previous) => previous ? { ...previous, taxonomyVersion: next.taxonomyVersion, progress: next.progress, taggingProgress: next.taggingProgress } : previous);
			const queued = data.settings.autoTaggingEnabled === 1 && next.taggingProgress.pending > 0;
			setReclassifying(queued);
			setWatchingTagging(queued);
		} catch (e) {
			setError(message(e, "Could not reclassify topics"));
			setReclassifying(false);
		}
	};

	const semanticOn = data.settings.semanticSearchEnabled === 1;
	const paused = data.settings.semanticIndexPaused === 1;
	const tagsOn = data.settings.autoTaggingEnabled === 1;
	const cloudflare = data.runtime === "cloudflare";
	const { indexed, total } = data.semanticIndex;
	const percent = total > 0 ? Math.min(100, (indexed / total) * 100) : 0;
	const remaining = Math.max(0, (parseCap(capDraft) ?? data.settings.semanticBudgetLimit) - data.settings.semanticBudgetUsed);
	const tagging = data.taggingProgress;

	return (
		<>
			{!data.available && <SettingsNotice icon={<Info {...ICON} />}>AI isn’t available here. Keyword search and manual tags still work</SettingsNotice>}
			{data.runtime === "ollama" && <SettingsNotice icon={<Info {...ICON} />}>Start Ollama and pull the configured models. Keyword search and manual tags work meanwhile</SettingsNotice>}
			{error && <SettingsNotice tone="danger">{error}</SettingsNotice>}
			<SettingsRow
				title="Search by meaning"
				description="Finds saves by what they’re about, not exact words"
				control={
					<Switch
						aria-label="Search by meaning"
						checked={semanticOn}
						disabled={saving || data.capabilities?.semanticSearch === false}
						onCheckedChange={(next) => (next ? askToEnable() : setConfirmOff(true))}
					/>
				}
			>
				{semanticOn && (
					<>
						<div className="settings-kv">
							<Progress value={percent} aria-label="Indexing progress" className="settings-progress" />
							<span className="settings-figure">
								{indexed.toLocaleString()} of {total.toLocaleString()} chunks
								{paused ? " · paused" : watchingSemantic ? " · updating" : ""}
							</span>
							<Button variant="outline" size="sm" className="settings-push" onClick={() => void setIndexPaused(!paused)}>
								{paused ? <Play {...ICON} /> : <Pause {...ICON} />}
								{paused ? "Resume indexing" : "Pause indexing"}
							</Button>
						</div>
						{cloudflare && (
							<>
								<div className="settings-kv">
									<label htmlFor="semantic-credit-limit" className="settings-label">Monthly credit cap</label>
									<form className="settings-joined settings-cap" onSubmit={(event) => { event.preventDefault(); void saveCap(); }}>
										<Input id="semantic-credit-limit" inputMode="numeric" value={capDraft} onChange={(event) => setCapDraft(event.target.value)} />
										<Button variant="outline" type="submit" aria-label="Save credit cap">Save</Button>
									</form>
									<span className="settings-muted">{data.settings.semanticBudgetUsed.toLocaleString()} used · resets {data.settings.semanticBudgetMonth}</span>
								</div>
								<p className="settings-meta">1 credit indexes up to 1,000 characters. It tracks workload, not your bill</p>
							</>
						)}
					</>
				)}
			</SettingsRow>
			<SettingsRow
				title="Automatic tags"
				badge={<Badge variant="outline" className="settings-badge">Beta</Badge>}
				description={data.capabilities?.autoTagging === false ? "No tag model is configured" : "Tags new saves by topic"}
				control={
					<Switch
						aria-label="Automatic tags"
						checked={tagsOn}
						disabled={data.capabilities?.autoTagging === false}
						onCheckedChange={(next) => update("autoTaggingEnabled", next)}
					/>
				}
			>
				{(tagsOn || tagging.complete + tagging.pending + tagging.failed > 0) && <div className="settings-kv">
					<span className="settings-figure">
						{tagging.complete.toLocaleString()} tagged · {tagging.pending.toLocaleString()} pending
						{tagging.failed > 0 && <span className="settings-inline-warn"> · {tagging.failed.toLocaleString()} failed</span>}
					</span>
					<span className="settings-muted">Topic list {data.taxonomyVersion}</span>
					<Button
						variant="outline"
						size="sm"
						className="settings-push"
						disabled={reclassifying || watchingTagging || data.capabilities?.autoTagging === false}
						onClick={() => void reclassify()}
					>
						<RefreshCw {...ICON} />
						{reclassifying ? "Reclassifying" : "Reclassify topics"}
					</Button>
				</div>}
			</SettingsRow>

			<Dialog open={preview !== null} onOpenChange={(open) => { if (!open && !saving) setPreview(null); }}>
				<DialogContent className="settings-dialog" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>Turn on search by meaning?</DialogTitle>
					</DialogHeader>
					{preview && (
						<>
							<dl className="settings-estimate">
								<dt>Saves</dt><dd>{preview.estimate.itemCount.toLocaleString()}</dd>
								<dt>Chunks to index</dt><dd>{preview.estimate.newChunks.toLocaleString()}</dd>
								<dt>{preview.runtime === "cloudflare" ? "Credits needed" : "Workload"}</dt><dd>about {preview.estimate.estimatedCredits.toLocaleString()}</dd>
								{preview.runtime === "cloudflare" && <><dt>Left this month</dt><dd>{remaining.toLocaleString()}</dd></>}
							</dl>
							{preview.runtime === "cloudflare" && (
								<div className="settings-kv">
									<label htmlFor="semantic-credit-limit-dialog" className="settings-label">Monthly credit cap</label>
									<Input id="semantic-credit-limit-dialog" className="settings-cap-input" inputMode="numeric" value={capDraft} onChange={(event) => setCapDraft(event.target.value)} />
								</div>
							)}
							<DialogDescription>
								{preview.runtime === "cloudflare"
									? "Cloudflare receives only titles and captured text. Past the cap, search falls back to keywords"
									: "Runs on this machine. No credits are used"}
							</DialogDescription>
							{previewError && <p role="alert" className="settings-message" data-tone="danger">{previewError}</p>}
						</>
					)}
					<DialogFooter>
						<Button variant="outline" disabled={saving} onClick={() => setPreview(null)}>Cancel</Button>
						<Button disabled={saving} onClick={() => void enableSemantic()}>{saving ? "Starting" : "Start indexing"}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
				<AlertDialogContent className="settings-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>Turn off search by meaning?</AlertDialogTitle>
						<AlertDialogDescription>Its index is deleted. Your saves and keyword search stay</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep it on</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={() => { setConfirmOff(false); update("semanticSearchEnabled", false); }}>
							Turn off
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Shown in place of the AI rows when the settings could not load. */
export function AiLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
	return (
		<SettingsRow
			title="AI"
			description={<span role="alert">{error}</span>}
			tone="danger"
			control={<Button variant="outline" onClick={onRetry}><RotateCcw {...ICON} />Try again</Button>}
		/>
	);
}
