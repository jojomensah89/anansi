CREATE TABLE link_preview_jobs (
 item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_run_at INTEGER NOT NULL DEFAULT 0,
 done INTEGER NOT NULL DEFAULT 0,
 claim_token TEXT
);
CREATE INDEX link_preview_jobs_due ON link_preview_jobs(done, next_run_at);
