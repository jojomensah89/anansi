ALTER TABLE ai_settings ADD COLUMN semantic_index_paused INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN semantic_budget_limit INTEGER NOT NULL DEFAULT 10000;
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN semantic_budget_used INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN semantic_budget_month TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN semantic_opted_in_at INTEGER;
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN semantic_generation INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE semantic_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  chunker_version TEXT NOT NULL,
  model TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  dimensions INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX semantic_chunks_item_model ON semantic_chunks(item_id, model);
--> statement-breakpoint
CREATE INDEX semantic_chunks_model_status ON semantic_chunks(model, status);
--> statement-breakpoint
CREATE INDEX semantic_chunks_model_generation_status ON semantic_chunks(model, generation, status);
--> statement-breakpoint
CREATE TABLE semantic_vector_deletions (
  vector_id TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX semantic_vector_deletions_due ON semantic_vector_deletions(next_run_at, created_at);
--> statement-breakpoint
CREATE TRIGGER semantic_chunks_delete_queue
BEFORE DELETE ON semantic_chunks
BEGIN
  INSERT OR IGNORE INTO semantic_vector_deletions(vector_id, created_at)
  VALUES (OLD.id, CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER item_embeddings_delete_queue
BEFORE DELETE ON item_embeddings
BEGIN
  INSERT OR IGNORE INTO semantic_vector_deletions(vector_id, created_at)
  VALUES (OLD.vector_id, CAST(strftime('%s','now') AS INTEGER));
END;
