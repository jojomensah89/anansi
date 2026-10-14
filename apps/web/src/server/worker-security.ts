export interface RequestLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface SecurityBindings {
  LOGIN_RATE_LIMITER?: RequestLimiter;
  INGEST_RATE_LIMITER?: RequestLimiter;
  MCP_RATE_LIMITER?: RequestLimiter;
}

/** Cloudflare counters are per location and eventually consistent, not global quotas. */
export async function limitPublicRequest(request: Request, env: SecurityBindings): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  let limiter: RequestLimiter | undefined;
  let group: string;
  if (path === "/api/auth/session" && request.method === "POST") {
    limiter = env.LOGIN_RATE_LIMITER;
    group = "login";
  } else if (path === "/api/ingest" || path.startsWith("/api/extension/")) {
    limiter = env.INGEST_RATE_LIMITER;
    group = "extension";
  } else if (path === "/mcp" && request.method === "POST") {
    limiter = env.MCP_RATE_LIMITER;
    group = "mcp";
  } else {
    return null;
  }
  if (!limiter) {
    return Response.json({ error: "request protection is not configured" }, { status: 503 });
  }
  // The edge supplies this header. Keying by bearer would let attackers evade
  // throttling by changing invalid credentials. Host separates same-account installs.
  const actor = request.headers.get("cf-connecting-ip") || "local";
  try {
    const { success } = await limiter.limit({ key: `${url.hostname}:${group}:${actor}` });
    if (success) return null;
    return Response.json({ error: "too many requests; retry shortly" }, {
      status: 429,
      headers: { "retry-after": "60", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "request protection is temporarily unavailable" }, {
      status: 503, headers: { "retry-after": "60", "cache-control": "no-store" },
    });
  }
}

export function secureResponse(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set("x-frame-options", "DENY");
  secured.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return secured;
}
