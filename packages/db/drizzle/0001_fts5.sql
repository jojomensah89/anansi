-- External-content FTS5 index over items.
--
-- `content='items'` means the index stores NO second copy of the text; it
-- points back into items by rowid. Half the storage and one source of truth,
-- which is why the three triggers below are mandatory rather than a nicety:
-- without them the index silently drifts from the table.
--
-- Not expressible in Drizzle's schema DSL, hence a custom migration. This is
-- also the reason `db:push` is unsafe on this project — push diffs the DSL
-- and knows nothing about any of this.

CREATE VIRTUAL TABLE items_fts USING fts5(
  body,
  title,
  author_handle,
  content='items',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
--> statement-breakpoint

CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, body, title, author_handle)
  VALUES (new.rowid, new.body, new.title, new.author_handle);
END;
--> statement-breakpoint

CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, body, title, author_handle)
  VALUES ('delete', old.rowid, old.body, old.title, old.author_handle);
END;
--> statement-breakpoint

CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, body, title, author_handle)
  VALUES ('delete', old.rowid, old.body, old.title, old.author_handle);
  INSERT INTO items_fts(rowid, body, title, author_handle)
  VALUES (new.rowid, new.body, new.title, new.author_handle);
END;
