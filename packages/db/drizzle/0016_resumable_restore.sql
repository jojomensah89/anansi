CREATE TABLE `restore_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`backup_id` text NOT NULL,
	`counts` text NOT NULL,
	`progress` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `restore_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`backup_id` text NOT NULL,
	`table_name` text NOT NULL,
	`offset` integer NOT NULL,
	`row_count` integer NOT NULL,
	`digest` text NOT NULL
);
