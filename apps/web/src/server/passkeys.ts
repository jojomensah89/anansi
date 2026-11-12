import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	type RegistrationResponseJSON,
	type AuthenticationResponseJSON,
	type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import {
	listStoredPasskeys,
	publicPasskey,
	ownerUserId,
	putChallenge,
	consumeChallenge,
	insertPasskey,
	removePasskey,
	renameStoredPasskey,
	usePasskey,
	type AnansiDb,
} from "@anansi/db";
import {
	allowedOrigin,
	cookieAuthenticated,
	sameSecret,
	sessionCookie,
	type LibraryAuthEnv,
} from "./library-auth.ts";
export const hasPasskeys = async (db: AnansiDb) =>
	(await listStoredPasskeys(db)).length > 0;
const CHALLENGE_COOKIE = "anansi_challenge";
const challengeCookie = (request: Request, id: string, age = 300) =>
	`${CHALLENGE_COOKIE}=${id}; Max-Age=${age}; Path=/api/auth; HttpOnly; SameSite=Strict${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
function defaultName(request: Request) {
	const ua = request.headers.get("user-agent") || "";
	return /iPhone|iPad/.test(ua)
		? "iPhone"
		: /Android/.test(ua)
			? "Android"
			: /Windows/.test(ua)
				? "Windows"
				: /Mac/.test(ua)
					? "Mac"
					: "Passkey";
}
export async function passkeyRoute(
	env: LibraryAuthEnv & { db: AnansiDb },
	request: Request,
): Promise<Response> {
	const headers = new Headers({ "cache-control": "no-store" });
	const json = (body: unknown, status = 200) =>
		Response.json(body, { status, headers });
	const url = new URL(request.url),
		path = url.pathname.replace(/\/+$/, "");
	if (request.method !== "GET" && !allowedOrigin(env, request))
		return json({ error: "origin is not allowed" }, 403);
	const verify = path.endsWith("/verify") && request.method === "POST";
	// Consume before parsing, authorization or cryptographic verification, even on failure.
	const kind = path.includes("/register/") ? "register" : "login";
	const challenge = verify
		? await consumeChallenge(
				env.db,
				request.headers
					.get("cookie")
					?.split(";")
					.map((s) => s.trim())
					.find((s) => s.startsWith(CHALLENGE_COOKIE + "="))
					?.slice(CHALLENGE_COOKIE.length + 1) || "",
				kind,
			)
		: null;
	if (verify) headers.append("set-cookie", challengeCookie(request, "", 0));
	if (!env.libraryToken)
		return json({ error: "library access is not configured" }, 503);
	let body: Record<string, unknown> = {};
	if (request.method !== "GET" && request.method !== "DELETE") {
		// Bound parsing before allocating the full request body.
		const reader = request.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > 65536) {
						await reader.cancel();
						return json({ error: "request too large" }, 413);
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		try {
			body = size ? JSON.parse(new TextDecoder().decode(bytes)) : {};
			if (!body || typeof body !== "object" || Array.isArray(body))
				throw Error();
		} catch {
			return json({ error: "invalid JSON" }, 400);
		}
	}
	const signedIn = cookieAuthenticated(env, request);
	const keys = await listStoredPasskeys(env.db);
	if (path === "/api/auth/passkeys" && request.method === "GET")
		return signedIn
			? json({ passkeys: keys.map(publicPasskey) })
			: json({ error: "unauthorized" }, 401);
	if (path.startsWith("/api/auth/passkeys/")) {
		if (!signedIn) return json({ error: "unauthorized" }, 401);
		const id = path.slice("/api/auth/passkeys/".length);
		if (!keys.some((p) => p.id === id))
			return json({ error: "not found" }, 404);
		if (request.method === "DELETE") {
			const rows = await removePasskey(env.db, id);
			return rows.length
				? json({ deleted: true })
				: json({ error: "last passkey" }, 409);
		}
		if (request.method === "PATCH") {
			if (
				typeof body.name !== "string" ||
				body.name.trim().length < 1 ||
				body.name.trim().length > 60
			)
				return json({ error: "invalid name" }, 400);
			const rows = await renameStoredPasskey(env.db, id, body.name.trim());
			return rows[0]
				? json({ passkey: publicPasskey(rows[0]) })
				: json({ error: "not found" }, 404);
		}
		return json({ error: "method not allowed" }, 405);
	}
	if (request.method !== "POST")
		return json({ error: "method not allowed" }, 405);
	if (
		![
			"/api/auth/passkey/register/options",
			"/api/auth/passkey/register/verify",
			"/api/auth/passkey/login/options",
			"/api/auth/passkey/login/verify",
		].includes(path)
	)
		return json({ error: "not found" }, 404);
	if (kind === "register") {
		if (
			!signedIn &&
			!(
				keys.length === 0 &&
				typeof body.secret === "string" &&
				sameSecret(body.secret, env.libraryToken)
			)
		)
			return json({ error: "unauthorized" }, 401);
		if (keys.length >= 10) return json({ error: "passkey limit" }, 409);
	} else if (!keys.length) return json({ error: "no passkeys" }, 404);
	const expectedRPID = url.hostname,
		expectedOrigin = url.origin;
	if (path.endsWith("/options")) {
		const options =
			kind === "register"
				? await generateRegistrationOptions({
						rpName: "Anansi",
						rpID: expectedRPID,
						userID: new TextEncoder().encode(await ownerUserId(env.db)),
						userName: "owner",
						userDisplayName: "Anansi owner",
						attestationType: "none",
						authenticatorSelection: {
							residentKey: "required",
							userVerification: "preferred",
						},
						excludeCredentials: keys.map((p) => ({
							id: p.id,
							transports: JSON.parse(
								p.transports,
							) as AuthenticatorTransportFuture[],
						})),
					})
				: await generateAuthenticationOptions({
						rpID: expectedRPID,
						allowCredentials: [],
						userVerification: "preferred",
					});
		const id = crypto.randomUUID();
		await putChallenge(env.db, id, options.challenge, kind);
		headers.append("set-cookie", challengeCookie(request, id));
		return json(options);
	}
	if (!challenge) return json({ error: "invalid or expired challenge" }, 400);
	try {
		if (kind === "register") {
			if (
				body.name !== undefined &&
				(typeof body.name !== "string" ||
					body.name.trim().length < 1 ||
					body.name.trim().length > 60)
			)
				return json({ error: "invalid name" }, 400);
			const result = await verifyRegistrationResponse({
				response: body.response as RegistrationResponseJSON,
				expectedChallenge: challenge,
				expectedOrigin,
				expectedRPID,
				requireUserVerification: false,
			});
			if (!result.verified || !result.registrationInfo)
				return json({ error: "verification failed" }, 400);
			const { credential, credentialDeviceType, credentialBackedUp } =
				result.registrationInfo;
			const rows = await insertPasskey(
				env.db,
				{
					id: credential.id,
					public_key: Buffer.from(credential.publicKey).toString("base64url"),
					counter: credential.counter,
					transports: JSON.stringify(credential.transports || []),
					device_type: credentialDeviceType,
					backed_up: Number(credentialBackedUp),
					name:
						typeof body.name === "string"
							? body.name.trim()
							: defaultName(request),
					created_at: Date.now(),
					last_used_at: null,
				},
				signedIn,
			);
			if (!rows[0]) return json({ error: "registration conflict" }, 409);
			headers.append("set-cookie", sessionCookie(env, request));
			return json({ passkey: publicPasskey(rows[0]) });
		}
		const response = body.response as AuthenticationResponseJSON;
		const key = keys.find((p) => p.id === response?.id);
		if (!key) return json({ error: "verification failed" }, 400);
		const result = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin,
			expectedRPID,
			requireUserVerification: false,
			credential: {
				id: key.id,
				publicKey: new Uint8Array(Buffer.from(key.public_key, "base64url")),
				counter: key.counter,
				transports: JSON.parse(key.transports),
			},
		});
		if (!result.verified) return json({ error: "verification failed" }, 400);
		if (
			!(
				await usePasskey(
					env.db,
					key,
					result.authenticationInfo.newCounter,
					result.authenticationInfo.credentialBackedUp,
				)
			).length
		)
			return json({ error: "verification conflict" }, 409);
		headers.append("set-cookie", sessionCookie(env, request));
		return json({ configured: true, authenticated: true, hasPasskey: true });
	} catch {
		return json({ error: "verification failed" }, 400);
	}
}
