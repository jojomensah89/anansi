CREATE TABLE passkeys (
 id TEXT PRIMARY KEY NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
 transports TEXT NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL,
 name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
);
--> statement-breakpoint
CREATE TABLE auth_challenges (id TEXT PRIMARY KEY NOT NULL, challenge TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE webauthn_owner (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL);
