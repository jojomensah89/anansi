ALTER TABLE `capture_events` ADD `capture_method` text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `capture_origin` text DEFAULT 'legacy_unknown' NOT NULL;