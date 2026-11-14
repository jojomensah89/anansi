CREATE TABLE platform_sync (source text PRIMARY KEY NOT NULL, requested_at integer NOT NULL DEFAULT 0, forced integer NOT NULL DEFAULT 0, trigger text NOT NULL DEFAULT 'library', agent_at integer NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE sync_settings (id integer PRIMARY KEY NOT NULL DEFAULT 1, agent_tabs integer NOT NULL DEFAULT 0, github_username text, github_checked_at integer, github_error text, github_retry_at integer NOT NULL DEFAULT 0);
