import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, type PasskeyRow, type SessionState } from "./api.ts";

export const sessionKey = ["auth", "session"] as const;
export const passkeysKey = ["auth", "passkeys"] as const;
export const PASSKEY_LIMIT = 10;

/** Ask the browser for a passkey and sign in with it. */
export async function signInWithPasskey(): Promise<SessionState> {
	const optionsJSON = await api.passkeyLoginOptions();
	const response = await startAuthentication({ optionsJSON });
	return api.passkeyLoginVerify(response);
}

/**
 * Create a passkey. Signed out, `secret` is the deploy secret that claims the
 * library the first time; signed in, it is left out.
 */
export async function addPasskey(secret?: string): Promise<PasskeyRow> {
	const optionsJSON = await api.passkeyRegisterOptions(secret);
	const response = await startRegistration({ optionsJSON });
	return (await api.passkeyRegisterVerify(response, undefined, secret)).passkey;
}

/**
 * What to say when a passkey step fails, or null when the person closed the
 * browser prompt themselves and nothing should be said.
 */
export function passkeyError(error: unknown): string | null {
	if (!(error instanceof Error)) return "Something went wrong. Try again";
	if (error.name === "NotAllowedError" || error.name === "AbortError") return null;
	if (error.name === "InvalidStateError") return "This device already has a passkey here";
	// Passkeys belong to a domain name; browsers refuse a bare IP such as 127.0.0.1.
	if (error.name === "SecurityError" && typeof location !== "undefined" && /^[\d.]+$|^\[/.test(location.hostname))
		return `Passkeys need a name, not an IP. Open ${location.protocol}//localhost${location.port ? `:${location.port}` : ""}`;
	if (error.name === "NotSupportedError" || error.name === "SecurityError") return "This browser can’t use passkeys here";
	const text = error.message;
	if (text === "unauthorized") return "That secret didn’t work";
	if (text === "passkey limit") return `You already have ${PASSKEY_LIMIT} passkeys`;
	if (text === "last passkey") return "Add another passkey before removing this one";
	if (text === "no passkeys") return "No passkey yet. Use the recovery secret";
	if (text === "invalid or expired challenge") return "That took too long. Try again";
	if (text.startsWith("verification") || text === "registration conflict") return "That passkey wasn’t accepted. Try again";
	if (text.startsWith("too many requests")) return "Too many tries. Wait a minute";
	if (text === "invalid name") return "Use 1 to 60 characters";
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "today", "yesterday", "4 days ago", or a date for anything older than a month. Takes unix ms. */
export function relativeDay(ms: number, now = Date.now()): string {
	const day = (t: number) => {
		const d = new Date(t);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	};
	const days = Math.round((day(now) - day(ms)) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days} days ago`;
	const date = new Date(ms);
	return date.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" as const } : {}),
	});
}

/** "Added 3 Mar · Used today" for a passkey row. */
export function passkeyMeta(row: Pick<PasskeyRow, "createdAt" | "lastUsedAt">, now = Date.now()): string {
	const added = `Added ${relativeDay(row.createdAt, now)}`;
	return row.lastUsedAt ? `${added} · Used ${relativeDay(row.lastUsedAt, now)}` : `${added} · Not used yet`;
}
