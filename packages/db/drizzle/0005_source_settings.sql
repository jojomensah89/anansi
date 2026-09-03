CREATE TABLE `source_settings` (
	`source` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer
);
