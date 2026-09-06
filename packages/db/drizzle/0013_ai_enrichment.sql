CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
  semantic_search_enabled INTEGER NOT NULL DEFAULT 0,
  auto_tagging_enabled INTEGER NOT NULL DEFAULT 0,
  embedding_model TEXT NOT NULL DEFAULT '@cf/baai/bge-small-en-v1.5',
  embedding_dimensions INTEGER NOT NULL DEFAULT 384,
  tag_model TEXT NOT NULL DEFAULT '@cf/meta/llama-3.1-8b-instruct',
  updated_at INTEGER NOT NULL DEFAULT 0,
  quota_pause_reason TEXT,
  last_run_at INTEGER
);
--> statement-breakpoint
CREATE TABLE ai_enrichment_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX ai_enrichment_jobs_due ON ai_enrichment_jobs(status, next_run_at, lease_until);
--> statement-breakpoint
CREATE INDEX ai_enrichment_jobs_item ON ai_enrichment_jobs(item_id);
--> statement-breakpoint
CREATE TABLE item_embeddings (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  vector_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
--> statement-breakpoint
CREATE TABLE item_tag_overrides (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  override TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, tag_id)
);
--> statement-breakpoint
ALTER TABLE item_tags ADD COLUMN provenance TEXT NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE item_tags ADD COLUMN model TEXT;
--> statement-breakpoint
ALTER TABLE item_tags ADD COLUMN applied_at INTEGER;
