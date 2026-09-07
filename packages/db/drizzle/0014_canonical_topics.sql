ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:web-dev', 'Web Dev', '#22c55e', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:ai-ml', 'AI / ML', '#3b82f6', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:marketing', 'Marketing', '#14b8a6', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:design', 'Design', '#eab308', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:startups', 'Startups', '#ec4899', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:product', 'Product', '#8b5cf6', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:career', 'Career', '#f97316', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:devops', 'DevOps', '#06b6d4', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:security', 'Security', '#ef4444', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:finance', 'Finance', '#84cc16', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
INSERT INTO tags (id, label, color, origin, kind) VALUES ('topic:health', 'Health', '#6366f1', 'ai', 'topic') ON CONFLICT(label) DO UPDATE SET color = excluded.color, kind = 'topic';
--> statement-breakpoint
DELETE FROM item_tags WHERE provenance = 'ai' AND tag_id IN (SELECT id FROM tags WHERE kind = 'custom');
--> statement-breakpoint
DELETE FROM tags WHERE origin = 'ai' AND kind = 'custom' AND NOT EXISTS (SELECT 1 FROM item_tags WHERE item_tags.tag_id = tags.id);
--> statement-breakpoint
UPDATE ai_enrichment_jobs SET status = 'pending', attempts = 0, next_run_at = 0, lease_until = 0, claim_token = NULL, last_error = NULL, updated_at = strftime('%s', 'now') WHERE kind = 'tagging';
