CREATE TABLE `acc_cursors` (
	`company_id` text NOT NULL,
	`consumer` text NOT NULL,
	`seq` integer NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `consumer`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_proposal_checks` (
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`version` integer NOT NULL,
	`checked_seq` integer NOT NULL,
	`stale` integer NOT NULL,
	`changed_json` text NOT NULL,
	`checked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `proposal_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`,`version`) REFERENCES `acc_proposal_versions`(`company_id`,`proposal_id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_schedules` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`rule` text NOT NULL,
	`params` text NOT NULL,
	`actor_id` text NOT NULL,
	`agent_id` text,
	`next_run_at` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedule_due` ON `acc_schedules` (`next_run_at`);