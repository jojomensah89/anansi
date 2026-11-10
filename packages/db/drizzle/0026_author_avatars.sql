CREATE TABLE author_avatars (
  origin_url TEXT PRIMARY KEY NOT NULL,
  stored_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT
);
--> statement-breakpoint
CREATE INDEX author_avatars_pending ON author_avatars(stored_key, next_run_at);

--> statement-breakpoint
CREATE INDEX items_author_avatar_latest ON items(source, author_handle, saved_at, id) WHERE author_avatar IS NOT NULL AND author_avatar <> '';
