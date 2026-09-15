CREATE TABLE `unsubscribe_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` text NOT NULL,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unsubscribe_events_token_id_unique` ON `unsubscribe_events` (`token_id`);--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`object_key` text NOT NULL,
	`published_at` integer NOT NULL,
	`revoked_at` integer
);
