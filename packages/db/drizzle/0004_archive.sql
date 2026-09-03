ALTER TABLE `items` ADD `archived_at` integer;--> statement-breakpoint
CREATE INDEX `items_archived` ON `items` (`archived_at`);