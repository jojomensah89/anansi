import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ConsentView, type ConsentRequest } from "../components/oauth-consent.tsx";

export const Route = createFileRoute("/oauth/authorize")({ component: Consent });

function Consent() {
  const params = Object.fromEntries(new URLSearchParams(typeof window === "undefined" ? "" : window.location.search));
  const description = useQuery({ queryKey: ["oauth-consent", params], queryFn: async () => {
    const response = await fetch(`/api/oauth/authorize?${new URLSearchParams(params)}`);
    if (!response.ok) throw new Error("Couldn’t load this request. Start connecting again from the app");
    return response.json() as Promise<{ok: boolean; name?: string; destination?: string; write?: boolean; message?: string}>;
  }, retry: false });
  const decision = useMutation({ mutationFn: async (allow: boolean) => {
    const response = await fetch("/api/oauth/authorize", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({params, allow}) });
    const result = await response.json().catch(() => ({})) as {redirect?: string; message?: string};
    if (!response.ok || !result.redirect) throw new Error(result.message ?? "Couldn’t complete approval. Try connecting again");
    window.location.assign(result.redirect);
  }});
  const data = description.data;
  const request: ConsentRequest = description.error
    ? { state: "invalid", message: description.error.message }
    : !data
      ? { state: "loading" }
      : data.ok === false
        ? { state: "invalid", message: data.message ?? "Couldn’t load this request. Start connecting again from the app" }
        : { state: "ready", name: data.name ?? "", destination: data.destination ?? "", write: data.write === true };
  return (
    <ConsentView
      request={request}
      pending={decision.isPending || decision.isSuccess ?(decision.variables ? "allow" : "deny") : null}
      error={decision.error?.message}
      onDecide={(allow) => decision.mutate(allow)}
    />
  );
}
