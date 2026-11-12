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
import { Input } from "@anansi/ui/components/input";
import { Progress } from "@anansi/ui/components/progress";
import { Switch } from "@anansi/ui/components/switch";
import { Info, Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
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
	/** Saves still waiting to be tagged or indexed, when this server can do the work. */
	const backlog = data.available && (
		(data.settings.autoTaggingEnabled === 1 && data.taggingProgress.pending > 0)
		|| (data.capabilities?.semanticSearch !== false && data.settings.semanticSearchEnabled === 1 && data.settings.semanticIndexPaused !== 1 && data.semanticIndex.pending > 0)
	);
	const backlogRef = useRef(backlog);
	backlogRef.current = backlog;
	/** True while this page is working through the backlog. */
	const [draining, setDraining] = useState(backlog);
	/** The last estimate, kept as quiet info once indexing is on. */
	const [estimate, setEstimate] = useState<Preview | null>(null);
	/** Set when the estimate is larger than what the cap leaves, so a dialog can ask. */
	const [overCap, setOverCap] = useState<{ preview: Preview; needed: number; limit: number } | null>(null);
	const [confirmOff, setConfirmOff] = useState(false);
	const [capDraft, setCapDraft] = useState(data.settings.semanticBudgetLimit.toLocaleString());
	const [saving, setSaving] = useState(false);

	// The server does one bounded pass per request, so the page asks again as
	// soon as each pass returns: one request in flight, only while visible.
	useEffect(() => {
		if (!draining) return;
		let stopped = false;
		void (async () => {
			while (!stopped && document.visibilityState === "visible") {
				try {
					const next = await api.drainAi();
					if (stopped) return;
					setData(next);
					if (next.error) setError(next.error);
					// Stop unless the pass made progress, so nothing can spin the loop.
					if (next.done || !(next.processed > 0)) break;
				} catch (e) {
					if (!stopped) setError(message(e, "Could not continue tagging and indexing"));
					break;
				}
			}
			if (stopped) return;
			setDraining(false);
			setReclassifying(false);
		})();
		return () => { stopped = true; };
	}, [draining, setData]);

	useEffect(() => {
		const resume = () => { if (document.visibilityState === "visible" && backlogRef.current) setDraining(true); };
		document.addEventListener("visibilitychange", resume);
		return () => document.removeEventListener("visibilitychange", resume);
	}, []);

	const update = (key: "semanticSearchEnabled" | "autoTaggingEnabled", value: boolean) => {
		setData({ ...data, settings: { ...data.settings, [key]: value ? 1 : 0 } });
		if (key === "autoTaggingEnabled" && !value) setReclassifying(false);
		api.updateAi({ [key]: value }).then((next) => {
			setData(next);
			if (value) setDraining(true);
		}).catch((e) => {
			setError(message(e, "Could not save settings"));
			void api.ai().then(setData).catch(() => undefined);
		});
	};

	/** Turning the switch on is the decision. Only a cap that cannot cover the estimate stops to ask. */
	const turnOn = (raisedLimit?: number) => {
		const limit = raisedLimit ?? parseCap(capDraft);
		if (limit === null) { setError("Enter a cap between 1 and 1,000,000"); return; }
		setError(null);
		setSaving(true);
		void (async () => {
			try {
				const next = await api.semanticPreview();
				if (capShortfall(next, limit, data.settings.semanticBudgetUsed)) {
					setOverCap({ preview: next, needed: data.settings.semanticBudgetUsed + next.estimate.estimatedCredits, limit });
					return;
				}
				const saved = await api.updateAi({ semanticSearchEnabled: true, semanticBudgetLimit: limit, confirmSemanticBackfill: true });
				setData(saved);
				setCapDraft(saved.settings.semanticBudgetLimit.toLocaleString());
				setEstimate(next);
				setDraining(true);
			} catch (e) {
				setError(message(e, "Could not turn on search by meaning"));
			} finally { setSaving(false); }
		})();
	};

	const raiseCap = () => {
		if (!overCap) return;
		const raised = Math.ceil(overCap.needed / 100) * 100;
		setOverCap(null);
		if (raised > 1_000_000) { setError("The estimate is above the largest cap, 1,000,000"); return; }
		setCapDraft(raised.toLocaleString());
		turnOn(raised);
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
			if (!paused && next.settings.semanticSearchEnabled === 1) setDraining(true);
		} catch (e) { setError(message(e, "Could not update indexing")); }
	};

	const reclassify = async () => {
		setReclassifying(true);
		try {
			const next = await api.reclassifyAiTags();
			setData((previous) => previous ? { ...previous, taxonomyVersion: next.taxonomyVersion, progress: next.progress, taggingProgress: next.taggingProgress } : previous);
			const queued = data.settings.autoTaggingEnabled === 1 && next.taggingProgress.pending > 0;
			setReclassifying(queued);
			if (queued) setDraining(true);
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
	const tagging = data.taggingProgress;
	const taggingTotal = tagging.complete + tagging.pending + tagging.failed;
	const taggingPercent = taggingTotal > 0 ? (tagging.complete / taggingTotal) * 100 : 0;
	const pending = Math.max(0, total - indexed);

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
						checked={semanticOn || (saving && overCap === null)}
						disabled={saving || data.capabilities?.semanticSearch === false}
						onCheckedChange={(next) => (next ? turnOn() : setConfirmOff(true))}
					/>
				}
			>
				{semanticOn && (
					<>
						<div className="settings-index">
							<Progress value={percent} aria-label="Indexing progress" className="settings-progress" />
							<Button variant="outline" size="sm" className="settings-index-action" onClick={() => void setIndexPaused(!paused)}>
								{paused ? <Play {...ICON} /> : <Pause {...ICON} />}
								{paused ? "Resume" : "Pause"}
							</Button>
							<p className="settings-figure settings-index-figure">
								{indexed.toLocaleString()} indexed · {pending.toLocaleString()} pending · {total.toLocaleString()} total
								{paused ? " · paused" : draining && pending > 0 ? " · updating" : ""}
							</p>
						</div>
						{cloudflare && (
							<>
								<div className="settings-cap-row">
									<label htmlFor="semantic-credit-limit" className="settings-label">Monthly credit cap</label>
									<form className="settings-joined settings-cap" onSubmit={(event) => { event.preventDefault(); void saveCap(); }}>
										<Input id="semantic-credit-limit" inputMode="numeric" value={capDraft} onChange={(event) => setCapDraft(event.target.value)} />
										<Button variant="outline" type="submit" aria-label="Save credit cap">Save</Button>
									</form>
									<span className="settings-muted">{data.settings.semanticBudgetUsed.toLocaleString()} used · resets {data.settings.semanticBudgetMonth}</span>
								</div>
								{estimate && (
									<p className="settings-muted settings-estimate-line">
										{estimate.estimate.itemCount.toLocaleString()} saves · about {estimate.estimate.estimatedCredits.toLocaleString()} credits to index · cap {data.settings.semanticBudgetLimit.toLocaleString()}
									</p>
								)}
								<p className="settings-meta">1 credit indexes up to 1,000 characters. It tracks workload, not your bill</p>
							</>
						)}
						{!cloudflare && estimate && (
							<p className="settings-muted settings-estimate-line">
								{estimate.estimate.itemCount.toLocaleString()} saves · {estimate.estimate.newChunks.toLocaleString()} chunks. Runs on this machine, no credits used
							</p>
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
				{(tagsOn || taggingTotal > 0) && (
					<>
						<div className="settings-index">
							<Progress value={taggingPercent} aria-label="Tagging progress" className="settings-progress" />
							<Button
								variant="outline"
								size="sm"
								className="settings-index-action"
								disabled={reclassifying || (draining && tagging.pending > 0) || data.capabilities?.autoTagging === false}
								onClick={() => void reclassify()}
							>
								<RefreshCw {...ICON} />
								{reclassifying ? "Reclassifying" : "Reclassify"}
							</Button>
							<p className="settings-figure settings-index-figure">
								{tagging.complete.toLocaleString()} complete · {tagging.pending.toLocaleString()} pending
								{tagging.failed > 0 && <span className="settings-inline-warn"> · {tagging.failed.toLocaleString()} failed</span>}
							</p>
						</div>
						<p className="settings-muted">Topic list {data.taxonomyVersion}</p>
					</>
				)}
			</SettingsRow>

			<AlertDialog open={overCap !== null} onOpenChange={(open) => { if (!open) setOverCap(null); }}>
				<AlertDialogContent className="settings-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>The cap is too low to index everything</AlertDialogTitle>
						<AlertDialogDescription>
							{overCap && `Indexing needs about ${overCap.preview.estimate.estimatedCredits.toLocaleString()} credits and ${Math.max(0, overCap.limit - data.settings.semanticBudgetUsed).toLocaleString()} are left this month. Raise the cap to ${(Math.ceil(overCap.needed / 100) * 100).toLocaleString()} to start, or leave search by meaning off`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={raiseCap}>Raise cap</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

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
