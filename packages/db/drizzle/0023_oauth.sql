CREATE TABLE oauth_clients (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL, connected_client_id TEXT);
--> statement-breakpoint
CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL, connected_client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE oauth_tokens (access_hash TEXT PRIMARY KEY NOT NULL, refresh_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, connected_client_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, access_expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX oauth_tokens_refresh_expiry ON oauth_tokens (refresh_expires_at);
