import { createHash, randomBytes, randomUUID } from "node:crypto";
import OAuth2Server, { Request as OAuthRequest, Response as OAuthResponse, OAuthError } from "@node-oauth/oauth2-server";
import { and, count, eq, isNull, lt } from "drizzle-orm";
import type { AnansiDb } from "@anansi/db";
import { connectedClients, oauthClients, oauthCodes, oauthTokens } from "../../../../packages/db/src/schema.ts";
import { createClient } from "./clients.ts";

/**
 * OAuth for apps connecting to the MCP endpoint.
 *
 * Self-hosted with one owner, so there are no users to choose between: approving
 * an app creates a row in Connected clients, and everything issued to it hangs
 * off that row. Revoking the row ends access on the next request.
 *
 * The library runs the grant rules. This file owns storage, app registration,
 * and what an authorization request may ask for. Stored credentials are hashes.
 */
export const READ_SCOPE = "library:read";
const CODE_SECONDS = 300;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 24 * 3600;
const MAX_UNAPPROVED_APPS = 200;
const MAX_BODY_BYTES = 16 * 1024;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const noStore = { "cache-control": "no-store", pragma: "no-cache" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });
const oauthError = (error: string, description: string, status = 400) =>
	reply({ error, error_description: description }, status);

export const mcpResource = (origin: string) => `${origin}/mcp`;

export function protectedResourceMetadata(origin: string) {
	return {
		resource: mcpResource(origin),
		authorization_servers: [origin],
		scopes_supported: [READ_SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: "Anansi",
	};
}

export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/api/oauth/token`,
		registration_endpoint: `${origin}/api/oauth/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: [READ_SCOPE],
	};
}

/** What the 401 from /mcp says, so a client can find its way to sign-in. */
export function mcpChallenge(origin: string, invalidToken: boolean) {
	const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
	return `Bearer ${invalidToken ? 'error="invalid_token", ' : ""}resource_metadata="${metadata}", scope="${READ_SCOPE}"`;
}

/**
 * HTTPS, loopback for desktop tools, or an app's own scheme (cursor://). Plain
 * http elsewhere and schemes that run content in the browser are refused.
 */
export function validRedirectUri(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2000) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.hash || url.username || url.password) return false;
	if (url.protocol === "https:") return true;
	if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	return !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"].includes(url.protocol);
}

/** Names are chosen by whoever registers, so only the destination is trustworthy. */
export function redirectLabel(redirectUri: string) {
	const url = new URL(redirectUri);
	return url.protocol === "https:" || url.protocol === "http:" ? url.host : `${url.protocol}//${url.host}`;
}

async function readBody(request: Request): Promise<string | null> {
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
	const text = await request.text().catch(() => null);
	return text !== null && text.length <= MAX_BODY_BYTES ? text : null;
}

export async function registerClient(db: AnansiDb, request: Request): Promise<Response> {
	const text = await readBody(request);
	if (text === null) return oauthError("invalid_client_metadata", "Registration is too large");
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(text);
	} catch {
		return oauthError("invalid_client_metadata", "Registration must be JSON");
	}
	const uris = body?.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(validRedirectUri)) {
		return oauthError("invalid_redirect_uri", "Redirect URIs must be HTTPS, loopback, or an app's own scheme");
	}
	const at = now();
	// Abandoned registrations were never approved, so they can go after a day.
	await db.delete(oauthClients).where(and(isNull(oauthClients.connectedClientId), lt(oauthClients.createdAt, at - 86400)));
	const [waiting] = await db.select({ n: count() }).from(oauthClients).where(isNull(oauthClients.connectedClientId));
	if ((waiting?.n ?? 0) >= MAX_UNAPPROVED_APPS) {
		return oauthError("temporarily_unavailable", "Too many apps are waiting for approval", 429);
	}
	const named = typeof body.client_name === "string" ? body.client_name.replace(/\p{Cc}/gu, "").trim().slice(0, 100) : "";
	const row = { id: randomUUID(), name: named || "Unnamed app", redirectUris: JSON.stringify(uris), createdAt: at };
	await db.insert(oauthClients).values(row);
	return reply({
		client_id: row.id,
		client_name: row.name,
		client_id_issued_at: at,
		redirect_uris: uris,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		scope: READ_SCOPE,
	}, 201);
}

const authClient = (row: typeof oauthClients.$inferSelect) => ({
	id: row.id,
	redirectUris: JSON.parse(row.redirectUris) as string[],
	grants: ["authorization_code", "refresh_token"],
});

async function activeConnection(db: AnansiDb, id: string) {
	const [row] = await db.select({ id: connectedClients.id, scopes: connectedClients.scopes }).from(connectedClients)
		.where(and(eq(connectedClients.id, id), eq(connectedClients.kind, "app"), isNull(connectedClients.revokedAt)));
	return row;
}

function serverFor(db: AnansiDb, resource: string) {
	const model = {
		generateAccessToken: async () => token("anansi_at_"),
		generateRefreshToken: async () => token("anansi_rt_"),
		generateAuthorizationCode: async () => token("anansi_ac_"),
		getClient: async (id: string) => {
			const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, id));
			return row ? authClient(row) : null;
		},
		validateScope: async (_user: unknown, _client: unknown, scope?: string[]) => {
			if (!scope?.length) return [READ_SCOPE];
			return scope.every((entry) => entry === READ_SCOPE) ? scope : false;
		},
		saveAuthorizationCode: async (code: any, client: any, user: any) => {
			await db.insert(oauthCodes).values({
				codeHash: hash(code.authorizationCode),
				clientId: client.id,
				connectedClientId: user.id,
				redirectUri: code.redirectUri,
				codeChallenge: code.codeChallenge,
				codeChallengeMethod: code.codeChallengeMethod,
				scope: (code.scope ?? [READ_SCOPE]).join(" "),
				expiresAt: Math.floor(code.expiresAt.getTime() / 1000),
			});
			return { ...code, client, user };
		},
		getAuthorizationCode: async (code: string) => {
			const [row] = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hash(code)));
			if (!row || !(await activeConnection(db, row.connectedClientId))) return null;
			return {
				authorizationCode: code,
				expiresAt: new Date(row.expiresAt * 1000),
				redirectUri: row.redirectUri,
				scope: row.scope.split(" "),
				codeChallenge: row.codeChallenge,
				codeChallengeMethod: row.codeChallengeMethod,
				client: { id: row.clientId, grants: ["authorization_code", "refresh_token"] },
				user: { id: row.connectedClientId },
			};
		},
		// Deleting is what makes a code single-use: only one exchange gets a row back.
		revokeAuthorizationCode: async (code: any) => {
			const rows = await db.delete(oauthCodes).where(eq(oauthCodes.codeHash, hash(code.authorizationCode))).returning({ id: oauthCodes.codeHash });
			return rows.length === 1;
		},
		saveToken: async (issued: any, client: any, user: any) => {
			await db.insert(oauthTokens).values({
				accessHash: hash(issued.accessToken),
				refreshHash: hash(issued.refreshToken),
				clientId: client.id,
				connectedClientId: user.id,
				scope: (issued.scope ?? [READ_SCOPE]).join(" "),
				resource,
				accessExpiresAt: Math.floor(issued.accessTokenExpiresAt.getTime() / 1000),
				refreshExpiresAt: Math.floor(issued.refreshTokenExpiresAt.getTime() / 1000),
			});
			return { ...issued, client, user };
		},
		getRefreshToken: async (refreshToken: string) => {
			const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.refreshHash, hash(refreshToken)));
			if (!row || row.resource !== resource || !(await activeConnection(db, row.connectedClientId))) return null;
			return {
				refreshToken,
				refreshTokenExpiresAt: new Date(row.refreshExpiresAt * 1000),
				scope: row.scope.split(" "),
				client: { id: row.clientId, grants: ["authorization_code", "refresh_token"] },
				user: { id: row.connectedClientId },
			};
		},
		// Rotation: a refresh token works once, and its access token ends with it.
		revokeToken: async (old: any) => {
			const rows = await db.delete(oauthTokens).where(eq(oauthTokens.refreshHash, hash(old.refreshToken))).returning({ id: oauthTokens.accessHash });
			return rows.length === 1;
		},
	};
	return new OAuth2Server({ model: model as never });
}

const respond = (response: OAuthResponse) => Response.json(response.body, { status: response.status ?? 200, headers: { ...response.headers, ...noStore } });

function failure(error: unknown) {
	if (error instanceof OAuthError) return oauthError(error.name, error.message, error.code);
	return oauthError("server_error", "The request could not be completed", 500);
}

export async function exchangeToken(db: AnansiDb, request: Request): Promise<Response> {
	const text = await readBody(request);
	if (text === null) return oauthError("invalid_request", "Request is too large");
	const body = Object.fromEntries(new URLSearchParams(text));
	const resource = mcpResource(new URL(request.url).origin);
	if (body.resource !== undefined && body.resource !== resource) return oauthError("invalid_target", "This server only issues tokens for its MCP endpoint");
	const at = now();
	await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, at));
	await db.delete(oauthTokens).where(lt(oauthTokens.refreshExpiresAt, at));
	const wrapped = new OAuthRequest({
		method: "POST",
		query: {},
		body,
		// The library checks the type through these, whatever transport delivered the body.
		headers: { "content-type": request.headers.get("content-type") ?? "", "content-length": String(text.length) },
	});
	const response = new OAuthResponse({ headers: {} });
	try {
		await serverFor(db, resource).token(wrapped, response, {
			requireClientAuthentication: { authorization_code: false, refresh_token: false },
			accessTokenLifetime: ACCESS_SECONDS,
			refreshTokenLifetime: REFRESH_SECONDS,
			alwaysIssueNewRefreshToken: true,
		});
		return respond(response);
	} catch (error) {
		return failure(error);
	}
}

export interface AuthorizationParams {
	response_type?: string;
	client_id?: string;
	redirect_uri?: string;
	code_challenge?: string;
	code_challenge_method?: string;
	scope?: string;
	state?: string;
	resource?: string;
}

type Inspected =
	| { ok: true; client: typeof oauthClients.$inferSelect; redirectUri: string }
	| { ok: false; error: string; message: string; redirectable: boolean };

/** Nothing is sent back to a redirect address until that address is confirmed. */
async function inspect(db: AnansiDb, origin: string, params: AuthorizationParams): Promise<Inspected> {
	const refuse = (error: string, message: string, redirectable = true): Inspected => ({ ok: false, error, message, redirectable });
	if (!params || typeof params !== "object" || Object.values(params).some(value => typeof value !== "string" || value.length > 4096)) return refuse("invalid_request", "This app sent an invalid connection request.", false);
	if (!params.client_id) return refuse("invalid_request", "The app didn't say who it is.", false);
	const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, params.client_id));
	if (!client) return refuse("invalid_client", "This app isn't registered with your library. Start connecting again from the app.", false);
	if (!params.redirect_uri || !(JSON.parse(client.redirectUris) as string[]).includes(params.redirect_uri)) {
		return refuse("invalid_redirect_uri", "This request would send you to an address the app didn't register.", false);
	}
	if (params.response_type !== "code") return refuse("unsupported_response_type", "This app asked to connect in a way Anansi doesn't support.");
	if (!params.code_challenge || params.code_challenge_method !== "S256") return refuse("invalid_request", "This app didn't use the required secure sign-in step (PKCE with S256).");
	if (params.scope && params.scope.split(" ").some((entry) => entry !== READ_SCOPE)) return refuse("invalid_scope", "This app asked for more than read access, which Anansi can't grant.");
	if (params.resource !== undefined && params.resource !== mcpResource(origin)) return refuse("invalid_target", "This app asked for access to a different server.");
	return { ok: true, client, redirectUri: params.redirect_uri };
}

export async function describeRequest(db: AnansiDb, origin: string, params: AuthorizationParams) {
	const checked = await inspect(db, origin, params);
	if (!checked.ok) return { ok: false as const, message: checked.message };
	// Consent never grants write. An app that reconnects keeps what the owner already allowed it.
	const existing = checked.client.connectedClientId ? await activeConnection(db, checked.client.connectedClientId) : undefined;
	const write = existing?.scopes.split(",").includes("write") ?? false;
	return { ok: true as const, name: checked.client.name, destination: redirectLabel(checked.redirectUri), write };
}

const withParams = (uri: string, params: Record<string, string | undefined>) => {
	const url = new URL(uri);
	for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
	return url.toString();
};

export async function decideRequest(db: AnansiDb, origin: string, params: AuthorizationParams, allow: boolean) {
	const checked = await inspect(db, origin, params);
	if (!checked.ok) {
		if (!checked.redirectable) return reply({ error: checked.error, message: checked.message }, 400);
		return reply({ redirect: withParams(params.redirect_uri!, { error: checked.error, error_description: checked.message, state: params.state }) });
	}
	if (!allow) return reply({ redirect: withParams(checked.redirectUri, { error: "access_denied", state: params.state }) });

	const existing = checked.client.connectedClientId ? await activeConnection(db, checked.client.connectedClientId) : undefined;
	const connectionId = existing?.id ?? (await createClient(db, checked.client.name, "app")).id;
	if (!existing) await db.update(oauthClients).set({ connectedClientId: connectionId }).where(eq(oauthClients.id, checked.client.id));

	const query = Object.fromEntries(Object.entries(params).filter(([key, value]) => key !== "resource" && value !== undefined)) as Record<string, string>;
	const response = new OAuthResponse({ headers: {} });
	try {
		await serverFor(db, mcpResource(origin)).authorize(new OAuthRequest({ method: "POST", query, body: {}, headers: {} }), response, {
			authenticateHandler: { handle: () => ({ id: connectionId }) },
			authorizationCodeLifetime: CODE_SECONDS,
			allowEmptyState: true,
			requirePKCE: true,
		} as never);
		return reply({ redirect: response.get("location") });
	} catch (error) {
		return failure(error);
	}
}

