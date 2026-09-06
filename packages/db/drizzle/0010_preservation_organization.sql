ALTER TABLE items ADD COLUMN article_text text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN article_format text NOT NULL DEFAULT 'plain';
--> statement-breakpoint
ALTER TABLE items ADD COLUMN content_truncated integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN search_text text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE items ADD COLUMN note text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE items ADD COLUMN favorite integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE highlights (id text PRIMARY KEY NOT NULL, item_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE, text text NOT NULL, created_at integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX highlights_item_text ON highlights(item_id, text);
--> statement-breakpoint
CREATE TABLE collections (id text PRIMARY KEY NOT NULL, name text NOT NULL, filters text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL);
--> statement-breakpoint
UPDATE items SET article_text = json_extract(raw, '$.text') WHERE source = 'web' AND json_valid(raw) AND json_type(raw, '$.text') = 'text';
--> statement-breakpoint
INSERT OR IGNORE INTO highlights(id,item_id,text,created_at) SELECT lower(hex(randomblob(16))),id,json_extract(raw,'$.selection'),saved_at FROM items WHERE source='web' AND json_valid(raw) AND json_type(raw,'$.selection')='text' AND length(trim(json_extract(raw,'$.selection')))>0;
--> statement-breakpoint
DROP TRIGGER items_ai;
--> statement-breakpoint
DROP TRIGGER items_ad;
--> statement-breakpoint
DROP TRIGGER items_au;
--> statement-breakpoint
DROP TABLE items_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE items_fts USING fts5(body,title,author_handle,article_text,search_text,content='items',content_rowid='rowid',tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
 INSERT INTO items_fts(rowid,body,title,author_handle,article_text,search_text) VALUES(new.rowid,new.body,new.title,new.author_handle,new.article_text,new.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
 INSERT INTO items_fts(items_fts,rowid,body,title,author_handle,article_text,search_text) VALUES('delete',old.rowid,old.body,old.title,old.author_handle,old.article_text,old.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
 INSERT INTO items_fts(items_fts,rowid,body,title,author_handle,article_text,search_text) VALUES('delete',old.rowid,old.body,old.title,old.author_handle,old.article_text,old.search_text);
 INSERT INTO items_fts(rowid,body,title,author_handle,article_text,search_text) VALUES(new.rowid,new.body,new.title,new.author_handle,new.article_text,new.search_text);
END;
--> statement-breakpoint
INSERT INTO items_fts(items_fts) VALUES('rebuild');
--> statement-breakpoint
UPDATE items SET search_text = coalesce((SELECT group_concat(t.label,' ') FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=items.id),'') || ' ' || coalesce((SELECT group_concat(h.text,' ') FROM highlights h WHERE h.item_id=items.id),'') || ' ' || note;
--> statement-breakpoint
CREATE TRIGGER item_tags_insert_search AFTER INSERT ON item_tags BEGIN UPDATE items SET search_text = coalesce((SELECT group_concat(t.label,' ') FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=items.id),'') || ' ' || coalesce((SELECT group_concat(h.text,' ') FROM highlights h WHERE h.item_id=items.id),'') || ' ' || note WHERE id=new.item_id; END;
--> statement-breakpoint
CREATE TRIGGER item_tags_delete_search AFTER DELETE ON item_tags BEGIN UPDATE items SET search_text = coalesce((SELECT group_concat(t.label,' ') FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=items.id),'') || ' ' || coalesce((SELECT group_concat(h.text,' ') FROM highlights h WHERE h.item_id=items.id),'') || ' ' || note WHERE id=old.item_id; END;
--> statement-breakpoint
CREATE TRIGGER highlights_insert_search AFTER INSERT ON highlights BEGIN UPDATE items SET search_text = coalesce((SELECT group_concat(t.label,' ') FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=items.id),'') || ' ' || coalesce((SELECT group_concat(h.text,' ') FROM highlights h WHERE h.item_id=items.id),'') || ' ' || note WHERE id=new.item_id; END;
--> statement-breakpoint
CREATE TRIGGER highlights_delete_search AFTER DELETE ON highlights BEGIN UPDATE items SET search_text = coalesce((SELECT group_concat(t.label,' ') FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=items.id),'') || ' ' || coalesce((SELECT group_concat(h.text,' ') FROM highlights h WHERE h.item_id=items.id),'') || ' ' || note WHERE id=old.item_id; END;
--> statement-breakpoint
CREATE TRIGGER items_note_search AFTER UPDATE OF note ON items BEGIN UPDATE items SET search_text = coalesce((SELECT group_concat(t.label,' ') FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=items.id),'') || ' ' || coalesce((SELECT group_concat(h.text,' ') FROM highlights h WHERE h.item_id=items.id),'') || ' ' || note WHERE id=new.id; END;
