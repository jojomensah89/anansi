import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { api, type AiSettingsResponse } from "../lib/api.ts";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
  const [data, setData] = useState<AiSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.ai().then(setData).catch((e) => setError(e instanceof Error ? e.message : "Unable to load settings")); }, []);
  const toggle = (key: "semanticSearchEnabled" | "autoTaggingEnabled", value: boolean) => {
    if (!data) return;
    setData({ ...data, settings: { ...data.settings, [key]: value ? 1 : 0 } });
    api.updateAi({ [key]: value }).catch((e) => { setError(e instanceof Error ? e.message : "Unable to save settings"); });
  };
  return <div className="anansi-shell" style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
    <Rail total={0} authors={0} bySource={{}} />
    <main className="anansi-settings-page">
      <h1 className="anansi-settings-title">Settings</h1>
      <p className="anansi-settings-subtitle">Optional AI features run in your Cloudflare account and never replace manual tags.</p>
      {error && <p role="alert" style={{ color: "var(--accent-text)" }}>{error}</p>}
      {!data ? <p className="mono">Loading…</p> : <>
        <section className="anansi-settings-section">
          <h2 className="anansi-settings-heading">AI features</h2>
          {!data.available && <p className="anansi-settings-unavailable">AI bindings are unavailable in this environment. Keyword search and manual tags continue to work.</p>}
          <div className="anansi-settings-list">
            <Toggle icon={<CpuIcon />} label="Enable AI semantic search" badge="Smart" description="Find content by meaning, not exact wording." checked={data.settings.semanticSearchEnabled === 1} onChange={(v) => toggle("semanticSearchEnabled", v)} />
            <Toggle icon={<SparkIcon />} label="Enable automatic tags" badge="Beta" description="Apply concise topic tags to new saves." checked={data.settings.autoTaggingEnabled === 1} onChange={(v) => toggle("autoTaggingEnabled", v)} />
          </div>
          <p className="mono anansi-settings-progress">{data.progress.pending} pending · {data.progress.complete} complete · {data.progress.failed} failed</p>
        </section>
      </>}
    </main>
  </div>;
}

function Toggle({ icon, label, badge, description, checked, onChange }: { icon: React.ReactNode; label: string; badge: "Smart" | "Beta"; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="anansi-settings-row">
    <span className="anansi-settings-icon" aria-hidden="true">{icon}</span>
    <span className="anansi-settings-copy"><strong>{label}</strong><span className={`anansi-settings-badge anansi-settings-badge-${badge.toLowerCase()}`}>{badge}</span><span className="anansi-settings-description">{description}</span></span>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="anansi-settings-toggle" data-state={checked ? "on" : "off"} onClick={() => onChange(!checked)}><span /></button>
  </div>;
}

function CpuIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4z" /></svg>; }
function SparkIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" /><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" /></svg>; }
