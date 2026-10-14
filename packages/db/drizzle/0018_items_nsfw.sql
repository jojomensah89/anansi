ALTER TABLE `items` ADD `nsfw` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `items_nsfw` ON `items` (`nsfw`);
