import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/oauth/authorize")({ component: Consent });

function Consent() {
  const params = Object.fromEntries(new URLSearchParams(typeof window === "undefined" ? "" : window.location.search));
  const description = useQuery({ queryKey: ["oauth-consent", params], queryFn: async () => {
    const response = await fetch(`/api/oauth/authorize?${new URLSearchParams(params)}`);
    if (!response.ok) throw new Error("Could not load this request. Start connecting again from the app.");
    return response.json() as Promise<{ok: boolean; name?: string; destination?: string; message?: string}>;
  }, retry: false });
  const decision = useMutation({ mutationFn: async (allow: boolean) => {
    const response = await fetch("/api/oauth/authorize", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({params, allow}) });
    const result = await response.json() as {redirect?: string; message?: string};
    if (!response.ok || !result.redirect) throw new Error(result.message ?? "Could not complete approval. Try connecting again.");
    window.location.assign(result.redirect);
  }});
  const request = description.data;
  const error = description.error?.message ?? (request?.ok === false ? request.message : undefined);
  return <main style={{minHeight:"100svh", background:"var(--ink)", padding:"48px 20px", display:"grid", placeItems:"center"}}>
    <section style={{width:"100%", maxWidth:480, padding:24, background:"var(--card)", border:"1px solid var(--line)", borderRadius:8, color:"var(--text)"}}>
      <h1 style={{fontSize:24, margin:"0 0 16px"}}>{error ? "Can’t connect this app" : "Allow access to your Anansi library?"}</h1>
      {error ? <p role="alert">{error}</p> : description.isPending ? <p>Loading request…</p> : <>
        <h2 style={{fontSize:18, overflowWrap:"anywhere"}}>{request?.name}</h2>
        <p style={{color:"var(--muted)", lineHeight:1.6}}>The app supplies this name, so it can’t be verified. Check where it returns before you allow.</p>
        <div style={{borderBlock:"1px solid var(--line)", paddingBlock:16, marginBlock:24}}>
          <p style={{margin:"0 0 8px"}}>Read-only. It can’t change or delete anything</p>
          <p style={{color:"var(--muted)", margin:0, overflowWrap:"anywhere"}}>Returns to <strong style={{color:"var(--text)"}}>{request?.destination}</strong></p>
        </div>
        <p style={{color:"var(--muted)", lineHeight:1.6}}>Revoke any time in Settings › Connected clients</p>
        {decision.error && <p role="alert">{decision.error.message}</p>}
        <div style={{display:"flex", gap:12, marginTop:24}}>
          <button disabled={decision.isPending} onClick={() => decision.mutate(true)} style={{minHeight:44, padding:"0 24px", background:"var(--accent)", color:"var(--ink)", border:0, borderRadius:6, fontWeight:600}}>Allow</button>
          <button disabled={decision.isPending} onClick={() => decision.mutate(false)} style={{minHeight:44, padding:"0 24px", background:"transparent", color:"var(--text)", border:"1px solid var(--edge-strong)", borderRadius:6}}>Deny</button>
        </div>
      </>}
    </section>
  </main>;
}

