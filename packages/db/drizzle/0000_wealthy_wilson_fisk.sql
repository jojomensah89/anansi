CREATE TABLE `item_tags` (
	`item_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `tag_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`kind` text NOT NULL,
	`author_handle` text,
	`author_name` text,
	`title` text,
	`body` text,
	`lang` text,
	`posted_at` integer,
	`saved_at` integer NOT NULL,
	`saved_at_exact` integer DEFAULT 0 NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`raw` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_external` ON `items` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `items_saved` ON `items` (`saved_at`);--> statement-breakpoint
CREATE INDEX `items_author` ON `items` (`author_handle`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`origin_url` text NOT NULL,
	`stored_key` text,
	`width` integer,
	`height` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_item_origin` ON `media` (`item_id`,`origin_url`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`origin` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_label_unique` ON `tags` (`label`);