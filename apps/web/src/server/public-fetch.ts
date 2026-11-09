import type { FetchBudget } from "./fetch-budget.ts";
import { isFetchableMediaUrl, isPublicAddress, localFetch } from "./media.ts";
/** Fixture adapters replace transport, never destination policy. Local DNS is pinned. */
export async function publicFetch(url: URL, signal: AbortSignal, runtime: "local" | "worker", request: typeof fetch = fetch, budget?: FetchBudget): Promise<Response> {
  if (!isFetchableMediaUrl(url.href)) throw new Error("refused non-public URL");
  if (runtime === "local") { budget?.consume(3); return localFetch(url, signal); }
  // Resolve both families and fail closed before sending the page request.
  // Worker fetch cannot pin DNS; rebinding resistance also depends on its network layer.
  if (!url.hostname.includes(":" ) && !/^[\d.]+$/.test(url.hostname)) {
    let found = false;
    for (const type of ["A", "AAAA"]) {
      budget?.consume();
      const result = await request(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`, { redirect:"manual", headers: {accept:"application/dns-json"}, signal });
      if (!result.ok) throw new Error("DNS validation failed");
      const dns = await result.json() as {Status:number; Answer?: {type:number;data:string}[]};
      if (dns.Answer?.some(a => [1,28].includes(a.type))) found = true;
      if (dns.Status !== 0 || dns.Answer?.some(a => [1,28].includes(a.type) && !isPublicAddress(a.data))) throw new Error("refused DNS destination");
    }
    if (!found) throw new Error("no public DNS addresses");
  }
  budget?.consume();
  return request(url, {redirect:"manual", signal, headers:{"User-Agent":"Anansi-LinkPreview/1.0"}});
}
