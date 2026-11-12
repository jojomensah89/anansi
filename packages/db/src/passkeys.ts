import { sql } from "drizzle-orm";
import type { AnansiDb } from "./types.ts";
export interface StoredPasskey {
	id: string;
	public_key: string;
	counter: number;
	transports: string;
	device_type: "singleDevice" | "multiDevice";
	backed_up: number;
	name: string;
	created_at: number;
	last_used_at: number | null;
}
export interface PasskeyRow {
	id: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	deviceType: string;
	backedUp: boolean;
}
export const publicPasskey = (p: StoredPasskey): PasskeyRow => ({
	id: p.id,
	name: p.name,
	createdAt: p.created_at,
	lastUsedAt: p.last_used_at,
	deviceType: p.device_type,
	backedUp: !!p.backed_up,
});
export const listStoredPasskeys = (db: AnansiDb) =>
	db.all<StoredPasskey>(sql`SELECT * FROM passkeys ORDER BY created_at, id`);
export async function ownerUserId(db: AnansiDb): Promise<string> {
	await db.run(
		sql`INSERT OR IGNORE INTO webauthn_owner VALUES (1, ${crypto.randomUUID()})`,
	);
	return (
		await db.all<{ user_id: string }>(
			sql`SELECT user_id FROM webauthn_owner WHERE id=1`,
		)
	)[0]!.user_id;
}
export async function putChallenge(
	db: AnansiDb,
	id: string,
	challenge: string,
	kind: string,
) {
	await db.run(
		sql`DELETE FROM auth_challenges WHERE expires_at <= ${Date.now()}`,
	);
	await db.run(
		sql`INSERT INTO auth_challenges VALUES (${id},${challenge},${kind},${Date.now() + 300000})`,
	);
}
export async function consumeChallenge(
	db: AnansiDb,
	id: string,
	kind: string,
): Promise<string | null> {
	const rows = await db.all<{
		challenge: string;
		kind: string;
		expires_at: number;
	}>(sql`DELETE FROM auth_challenges WHERE id=${id} RETURNING *`);
	const row = rows[0];
	return row && row.kind === kind && row.expires_at > Date.now()
		? row.challenge
		: null;
}
/** Conditional statements serialize limits and first-claim authorization with the write. */
export async function insertPasskey(
	db: AnansiDb,
	p: StoredPasskey,
	signedIn: boolean,
) {
	return db.all<StoredPasskey>(
		sql`INSERT INTO passkeys SELECT ${p.id},${p.public_key},${p.counter},${p.transports},${p.device_type},${p.backed_up},${p.name},${p.created_at},NULL WHERE (SELECT count(*) FROM passkeys)<${signedIn ? 10 : 1} ON CONFLICT(id) DO NOTHING RETURNING *`,
	);
}
export const removePasskey = (db: AnansiDb, id: string) =>
	db.all<StoredPasskey>(
		sql`DELETE FROM passkeys WHERE id=${id} AND (SELECT count(*) FROM passkeys)>1 RETURNING *`,
	);
export const renameStoredPasskey = (db: AnansiDb, id: string, name: string) =>
	db.all<StoredPasskey>(
		sql`UPDATE passkeys SET name=${name} WHERE id=${id} RETURNING *`,
	);
export const usePasskey = (
	db: AnansiDb,
	p: StoredPasskey,
	counter: number,
	backedUp: boolean,
) =>
	db.all<StoredPasskey>(
		sql`UPDATE passkeys SET counter=${counter},last_used_at=${Date.now()},backed_up=${Number(backedUp)} WHERE id=${p.id} AND counter=${p.counter} RETURNING *`,
	);
