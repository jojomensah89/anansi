ALTER TABLE media ADD COLUMN identity TEXT GENERATED ALWAYS AS (CASE
 WHEN substr(origin_url, 1, 8) = 'https://' AND (lower(substr(origin_url, 9, instr(substr(origin_url, 9), '/') - 1)) GLOB '*.tiktokcdn.com' OR lower(substr(origin_url, 9, instr(substr(origin_url, 9), '/') - 1)) GLOB '*.tiktokcdn-us.com') THEN 'tiktokcdn:' || substr((CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END), 8 + instr(substr(origin_url, 9), '/'))
 WHEN substr(origin_url, 1, 8) = 'https://' AND (lower(substr(origin_url, 9, instr(substr(origin_url, 9), '/') - 1)) IN ('preview.redd.it', 'external-preview.redd.it') OR lower(substr(origin_url, 9, instr(substr(origin_url, 9), '/') - 1)) GLOB '*.cdninstagram.com' OR lower(substr(origin_url, 9, instr(substr(origin_url, 9), '/') - 1)) GLOB '*.fbcdn.net') THEN CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END
 WHEN lower(substr(origin_url, 9, instr(substr(origin_url, 9), '/') - 1)) = 'pbs.twimg.com' THEN CASE
   WHEN lower(substr((CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END), -4)) IN ('.jpg', '.png') THEN substr((CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END), 1, length((CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END)) - 4)
   WHEN lower(substr((CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END), -5)) IN ('.jpeg', '.webp') THEN substr((CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END), 1, length((CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END)) - 5)
   ELSE CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END END
 ELSE origin_url END) VIRTUAL;
--> statement-breakpoint
CREATE TABLE media_orphan_objects (stored_key TEXT PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TABLE media_identity_merges AS SELECT id AS removed_id, first_value(id) OVER (PARTITION BY item_id, identity ORDER BY (stored_key IS NULL), rowid) AS kept_id FROM media;
--> statement-breakpoint
INSERT OR IGNORE INTO media_orphan_objects SELECT stored_key FROM media WHERE id IN (SELECT removed_id FROM media_identity_merges WHERE removed_id <> kept_id) AND stored_key IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO media_jobs(media_id, attempts, next_run_at, lease_until) SELECT DISTINCT kept_id, 0, 0, 0 FROM media_identity_merges JOIN media_jobs ON media_jobs.media_id=removed_id WHERE removed_id <> kept_id;
--> statement-breakpoint
DELETE FROM media_jobs WHERE media_id IN (SELECT removed_id FROM media_identity_merges WHERE removed_id <> kept_id);
--> statement-breakpoint
DELETE FROM media WHERE id IN (SELECT removed_id FROM media_identity_merges WHERE removed_id <> kept_id);
--> statement-breakpoint
DROP TABLE media_identity_merges;
--> statement-breakpoint
DROP INDEX media_item_origin;
--> statement-breakpoint
CREATE UNIQUE INDEX media_item_identity ON media(item_id, identity);
