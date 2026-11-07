CREATE TABLE connected_clients (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, scopes TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_use INTEGER, revoked_at INTEGER);
--> statement-breakpoint
CREATE TABLE client_security (id INTEGER PRIMARY KEY NOT NULL, retired_at INTEGER);
