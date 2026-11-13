-- Shelves: saved views grow a colour, an icon, an order, and hand-picked items.
-- The table keeps its name so existing deployments migrate in place.
ALTER TABLE collections ADD COLUMN color TEXT;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN icon TEXT;
--> statement-breakpoint
ALTER TABLE collections ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE collections SET position = (
  SELECT count(*) FROM collections earlier
  WHERE earlier.created_at < collections.created_at
     OR (earlier.created_at = collections.created_at AND earlier.id < collections.id)
);
--> statement-breakpoint
CREATE TABLE shelf_items (
  shelf_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('include', 'exclude')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (shelf_id, item_id)
);
--> statement-breakpoint
CREATE INDEX shelf_items_item ON shelf_items (item_id);
--> statement-breakpoint
-- Topic shelves the owner said no to. Keyed by topic id.
CREATE TABLE shelf_suggestion_dismissals (
  topic TEXT PRIMARY KEY NOT NULL,
  dismissed_at INTEGER NOT NULL
);
--> statement-breakpoint
-- Owner edits to the AI topic list. A built-in topic has a row only once it
-- is switched off or its description is changed; a custom topic always has one.
CREATE TABLE ai_topics (
  id TEXT PRIMARY KEY NOT NULL,
  built_in INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  description TEXT,
  color TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
