CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text NOT NULL,
	`overtime` real,
	`final_tie` real
);
--> statement-breakpoint
CREATE INDEX `idx_games_updated` ON `games` (`updated_at`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`observed_at` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_game_time` ON `snapshots` (`game_id`,`observed_at`);