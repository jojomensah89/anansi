-- One-time migration-ledger handoff for an existing Alchemy deployment.
-- Back up D1 and confirm the names in __alchemy_migrations match the
-- repository's packages/db/drizzle/*.sql files before running this script.
CREATE TABLE IF NOT EXISTS d1_migrations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE,
	applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name, applied_at)
SELECT name, COALESCE(applied_at, CURRENT_TIMESTAMP)
FROM __alchemy_migrations
WHERE name IS NOT NULL;
