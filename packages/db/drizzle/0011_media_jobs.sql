CREATE TABLE media_jobs (
 media_id TEXT PRIMARY KEY NOT NULL REFERENCES media(id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_run_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,
 claim_token TEXT,
 last_error TEXT
);
--> statement-breakpoint
CREATE INDEX media_jobs_due ON media_jobs(next_run_at, lease_until);
