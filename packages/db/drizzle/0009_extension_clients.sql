CREATE TABLE `extension_clients` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`extension_version` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`queue` text NOT NULL,
	`sources` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `extension_clients_last_seen` ON `extension_clients` (`last_seen_at`);