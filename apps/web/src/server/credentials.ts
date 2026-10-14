export interface CredentialEnvironment {
  ANANSI_SECRET?: unknown;
  LIBRARY_TOKEN?: unknown;
  INGEST_TOKEN?: unknown;
  MCP_TOKEN?: unknown;
}

export interface ServerCredentials {
  libraryToken?: string;
  ingestToken?: string;
  mcpToken?: string;
}

function normalizeCredential(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/** Role-specific credentials override the shared compatibility secret. */
export function resolveServerCredentials(env: CredentialEnvironment): ServerCredentials {
  const fallback = normalizeCredential(env.ANANSI_SECRET);
  return {
    libraryToken: normalizeCredential(env.LIBRARY_TOKEN) ?? fallback,
    ingestToken: normalizeCredential(env.INGEST_TOKEN) ?? fallback,
    mcpToken: normalizeCredential(env.MCP_TOKEN) ?? fallback,
  };
}
