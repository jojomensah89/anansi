-- Avoid double FTS writes from the nested note/search_text update.
DROP TRIGGER items_au;
--> statement-breakpoint
CREATE TRIGGER items_au AFTER UPDATE OF body,title,author_handle,article_text,search_text ON items BEGIN
 INSERT INTO items_fts(items_fts,rowid,body,title,author_handle,article_text,search_text) VALUES('delete',old.rowid,old.body,old.title,old.author_handle,old.article_text,old.search_text);
 INSERT INTO items_fts(rowid,body,title,author_handle,article_text,search_text) VALUES(new.rowid,new.body,new.title,new.author_handle,new.article_text,new.search_text);
END;
--> statement-breakpoint
INSERT INTO items_fts(items_fts) VALUES('rebuild');
