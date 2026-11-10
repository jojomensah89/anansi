import { ConnectedClients } from "../components/connected-clients.tsx";
import { SyncControls } from "../components/sync-controls.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { SettingsSkeleton, useSlowLoad } from "../components/skeleton.tsx";
import { api, type AiSettingsResponse } from "../lib/api.ts";
import { useShowNsfw } from "../lib/settings.ts";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
  const [counts,setCounts]=useState<Awaited<ReturnType<typeof api.stats>>|null>(null);
  useEffect(()=>{void api.stats().then(setCounts).catch(()=>undefined);},[]);
  const [showNsfw, setShowNsfw] = useShowNsfw();
  const [data, setData] = useState<AiSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reclassifying, setReclassifying] = useState(false);
  const [watchingTagging, setWatchingTagging] = useState(false);
  const [watchingSemantic, setWatchingSemantic] = useState(false);
  const [semanticPreview, setSemanticPreview] = useState<Awaited<ReturnType<typeof api.semanticPreview>> | null>(null);
  const [semanticLimitDraft, setSemanticLimitDraft] = useState("10000");
  const [savingSemantic, setSavingSemantic] = useState(false);
  useEffect(() => {
    api.ai().then((next) => {
      setData(next);
      setSemanticLimitDraft(String(next.settings.semanticBudgetLimit));
      setWatchingTagging(next.settings.autoTaggingEnabled === 1 && next.taggingProgress.pending > 0);
    }).catch((e) => setError(e instanceof Error ? e.message : "Could not load settings"));
  }, []);
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
        setError(e instanceof Error ? e.message : "Could not refresh indexing progress");
        setWatchingSemantic(false);
      });
    }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [watchingSemantic]);
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
        setError(e instanceof Error ? e.message : "Could not refresh tagging progress");
        setWatchingTagging(false);
        setReclassifying(false);
      });
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [watchingTagging]);
  const slow = useSlowLoad(data === null && !error);
  const toggle = (key: "semanticSearchEnabled" | "autoTaggingEnabled", value: boolean) => {
    if (!data) return;
    if (key === "semanticSearchEnabled") {
      if (value) {
        setError(null);
        setSavingSemantic(true);
        api.semanticPreview().then(setSemanticPreview).catch((e) => setError(e instanceof Error ? e.message : "Could not estimate indexing"))
          .finally(() => setSavingSemantic(false));
        return;
      }
      if (!window.confirm("Turn off search by meaning and delete its index? Your saves and keyword search stay.")) return;
    }
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
      setError(e instanceof Error ? e.message : "Could not save settings");
      void api.ai().then((latest) => setData(latest)).catch(() => undefined);
    });
  };
  const enableSemantic = async () => {
    if (!data || !semanticPreview) return;
    const limit = Number(semanticLimitDraft);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
      setError("Enter a cap between 1 and 1,000,000");
      return;
    }
    const remaining = Math.max(0, limit - data.settings.semanticBudgetUsed);
    if (semanticPreview.runtime === "cloudflare" && semanticPreview.estimate.estimatedCredits > remaining) {
      setError(`Indexing needs ${semanticPreview.estimate.estimatedCredits} credits but only ${remaining} are left this month. Raise the cap or wait for the reset.`);
      return;
    }
    setSavingSemantic(true);
    setError(null);
    try {
      const next = await api.updateAi({ semanticSearchEnabled: true, semanticBudgetLimit: limit, confirmSemanticBackfill: true });
      setData(next);
      setSemanticPreview(null);
      setWatchingSemantic(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn on search by meaning");
    } finally { setSavingSemantic(false); }
  };
  const saveSemanticLimit = async () => {
    const limit = Number(semanticLimitDraft);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) { setError("Enter a cap between 1 and 1,000,000"); return; }
    try {
      const next = await api.updateAi({ semanticBudgetLimit: limit });
      setData(next);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the cap"); }
  };
  const setIndexPaused = async (paused: boolean) => {
    try {
      const next = await api.updateAi({ semanticIndexPaused: paused });
      setData(next);
      setWatchingSemantic(!paused && next.settings.semanticSearchEnabled === 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update indexing"); }
  };
  const reclassify = async () => {
    setReclassifying(true);
    try {
      const next = await api.reclassifyAiTags();
      setData((previous) => previous ? { ...previous, taxonomyVersion: next.taxonomyVersion, progress: next.progress, taggingProgress: next.taggingProgress } : previous);
      const queued = data?.settings.autoTaggingEnabled === 1 && next.taggingProgress.pending > 0;
      setReclassifying(queued);
      setWatchingTagging(queued);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reclassify topics");
      setReclassifying(false);
    }
  };
  return <div className="anansi-shell" style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
    <Rail total={counts?.items ?? 0} authors={counts?.authors ?? 0} archived={counts?.archived ?? 0} bySource={counts?.bySource ?? {}} ready={counts !== null} />
    <main className="anansi-settings-page">
      <h1 className="anansi-settings-title">Settings</h1>
      <ConnectedClients />
      <SyncControls settings />
      {error && <p role="alert" style={{ color: "var(--accent-text)" }}>{error}</p>}
      {!data ? (error ? null : slow ? <SettingsSkeleton /> : null) :
        <section className="anansi-settings-section">
          <h2 className="anansi-settings-heading">AI features</h2>
      <p className="anansi-settings-subtitle">{data.runtime === "ollama" ? "Runs through Ollama on this machine" : "Runs in your Cloudflare account. Manual tags are never replaced"}</p>
          {!data.available && <p className="anansi-settings-unavailable">AI isn’t available here. Keyword search and manual tags still work</p>}
          {data.runtime === "ollama" && <p className="anansi-settings-unavailable">Start Ollama and pull the configured models. Keyword search and manual tags work meanwhile</p>}
          <div className="anansi-settings-list">
            <Toggle icon={<CpuIcon />} label="Search by meaning" description="Finds saves by what they’re about, not exact words. Indexes in the background" checked={data.settings.semanticSearchEnabled === 1} disabled={savingSemantic || data.capabilities?.semanticSearch === false} onChange={(v) => toggle("semanticSearchEnabled", v)} />
            {data.settings.semanticSearchEnabled === 1 && <div style={{ margin: "-2px 0 12px 42px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="anansi-settings-progress">{data.semanticIndex.indexed.toLocaleString()} of {data.semanticIndex.total.toLocaleString()} chunks indexed{data.semanticIndex.pending ? ` · ${data.semanticIndex.pending.toLocaleString()} pending` : ""}{watchingSemantic ? " · updating…" : ""}</span>
              <button type="button" onClick={() => void setIndexPaused(data.settings.semanticIndexPaused !== 1)} style={smallButtonStyle}>{data.settings.semanticIndexPaused === 1 ? "Resume indexing" : "Pause indexing"}</button>
            </div>}
            {data.runtime === "cloudflare" && <div style={{ margin: "0 0 12px 42px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label htmlFor="semantic-credit-limit" style={metaStyle}>Monthly credit cap</label>
              <input id="semantic-credit-limit" type="number" min={1} max={1_000_000} value={semanticLimitDraft} onChange={(event) => setSemanticLimitDraft(event.target.value)} style={{ width: 100, background: "var(--surface)", color: "var(--text)", border: "1px solid var(--edge)", borderRadius: 5, padding: "5px 7px" }} />
              <span style={metaStyle}>{data.settings.semanticBudgetUsed.toLocaleString()} used · resets {data.settings.semanticBudgetMonth}</span>
              <button type="button" onClick={() => void saveSemanticLimit()} aria-label="Save credit cap" style={smallButtonStyle}>Save</button>
              <p style={{ ...metaStyle, flexBasis: "100%", margin: "2px 0 0" }}>1 credit is up to 1,000 characters indexed. It tracks workload, not your bill</p>
            </div>}
            {semanticPreview && <div role="dialog" aria-label="Semantic search indexing estimate" style={{ margin: "0 0 14px 42px", padding: 12, border: "1px solid var(--edge)", borderRadius: 8, background: "var(--surface)" }}>
              <strong>Indexing estimate</strong>
              <p style={{ ...metaStyle, lineHeight: 1.5 }}>{semanticPreview.estimate.itemCount.toLocaleString()} saves · {semanticPreview.estimate.newChunks.toLocaleString()} new chunks of {semanticPreview.estimate.totalChunks.toLocaleString()} · about {semanticPreview.estimate.estimatedCredits.toLocaleString()} {semanticPreview.runtime === "cloudflare" ? "credits" : "workload units"}{semanticPreview.runtime === "cloudflare" ? ` · ${Math.max(0, Number(semanticLimitDraft) - data.settings.semanticBudgetUsed).toLocaleString()} left this month` : " · runs locally, no credits used"}</p>
              {semanticPreview.runtime === "cloudflare" && <p style={{ ...metaStyle, lineHeight: 1.5 }}>Cloudflare receives only titles and captured text. Past the cap, search falls back to keywords.</p>}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={savingSemantic} onClick={() => void enableSemantic()} style={smallButtonStyle}>{savingSemantic ? "Starting…" : "Start indexing"}</button>
                <button type="button" disabled={savingSemantic} onClick={() => setSemanticPreview(null)} style={smallButtonStyle}>Cancel</button>
              </div>
            </div>}
            <Toggle icon={<SparkIcon />} label="Automatic tags" badge="Beta" description={data.capabilities?.autoTagging === false ? "No tag model is configured" : "Tags new saves by topic"} checked={data.settings.autoTaggingEnabled === 1} disabled={data.capabilities?.autoTagging === false} onChange={(v) => toggle("autoTaggingEnabled", v)} />
          </div>
          <p className="anansi-settings-progress">{data.taggingProgress.complete.toLocaleString()} tagged · {data.taggingProgress.pending.toLocaleString()} pending{data.taggingProgress.failed ? ` · ${data.taggingProgress.failed.toLocaleString()} failed` : ""}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
            <span style={metaStyle}>Topic list {data.taxonomyVersion}</span>
            <button type="button" disabled={reclassifying || watchingTagging || data.capabilities?.autoTagging === false} onClick={() => void reclassify()} style={{ ...smallButtonStyle, cursor: reclassifying || watchingTagging ? "wait" : "pointer" }}>{reclassifying ? "Reclassifying…" : "Reclassify topics"}</button>
          </div>
        </section>}
      <section className="anansi-settings-section" style={{ marginTop: 28 }}>
        <h2 className="anansi-settings-heading">Content & display</h2>
        <div className="anansi-settings-list">
          <Toggle
            icon={<ShieldIcon />}
            label="Show sensitive content"
            description="Posts X and Reddit mark as sensitive or adult"
            checked={showNsfw}
            onChange={setShowNsfw}
          />
        </div>
      </section>
    </main>
  </div>;
}

const smallButtonStyle: React.CSSProperties = { border: "1px solid var(--edge)", borderRadius: 5, padding: "5px 10px", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer" };
const metaStyle: React.CSSProperties = { color: "var(--muted)", fontSize: 12 };

function Toggle({ icon, label, badge, description, checked, disabled = false, onChange }: { icon: React.ReactNode; label: string; badge?: "Beta"; description: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <div className="anansi-settings-row">
    <span className="anansi-settings-icon" aria-hidden="true">{icon}</span>
    <span className="anansi-settings-copy"><strong>{label}</strong>{badge && <span className={`anansi-settings-badge anansi-settings-badge-${badge.toLowerCase()}`}>{badge}</span>}<span className="anansi-settings-description">{description}</span></span>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="anansi-settings-toggle" data-state={checked ? "on" : "off"} onClick={() => onChange(!checked)}><span /></button>
  </div>;
}

function CpuIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4z" /></svg>; }
function SparkIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" /><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" /></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>; }
