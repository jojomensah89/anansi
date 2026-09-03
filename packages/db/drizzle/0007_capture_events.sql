CREATE TABLE `capture_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`action` text NOT NULL,
	`observed_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`item_id` text,
	`outcome` text NOT NULL,
	`receipt` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `capture_events_source_observed` ON `capture_events` (`source`,`observed_at`);--> statement-breakpoint
CREATE INDEX `capture_events_item` ON `capture_events` (`item_id`);--> statement-breakpoint
CREATE TABLE `item_source_links` (
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`item_id` text NOT NULL,
	`present` integer DEFAULT 1 NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `external_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_source_links_item_present` ON `item_source_links` (`item_id`,`present`);--> statement-breakpoint
ALTER TABLE `items` ADD `platform_saved` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `removed_from_source_at` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `last_source_event_at` integer;--> statement-breakpoint
CREATE INDEX `items_platform_saved` ON `items` (`platform_saved`);