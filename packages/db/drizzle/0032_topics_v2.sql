-- Topic list v2: eight topics beyond tech and business, then tag every save again.
-- Existing AI topics stay on each save until its new topics replace them.
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:hardware', 'Hardware & Networking', '#0ea5e9', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:entertainment', 'Entertainment & Anime', '#f43f5e', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:gaming', 'Gaming', '#a855f7', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:music', 'Music', '#d946ef', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:food-travel', 'Food & Travel', '#f59e0b', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:science', 'Science', '#10b981', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:learning', 'Learning', '#64748b', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:lifestyle', 'Lifestyle', '#fb7185', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
UPDATE ai_enrichment_jobs SET status = 'pending', attempts = 0, next_run_at = 0, lease_until = 0, claim_token = NULL, last_error = NULL, updated_at = strftime('%s', 'now') WHERE kind = 'tagging';
