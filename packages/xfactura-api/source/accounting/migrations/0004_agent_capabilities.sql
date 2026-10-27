CREATE TABLE `acc_action_reviews` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`operation` text NOT NULL,
	`input` text NOT NULL,
	`effect` text NOT NULL,
	`hash` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`result` text,
	`executed_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_agent_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acc_agent_grants_token_hash_unique` ON `acc_agent_grants` (`token_hash`);--> statement-breakpoint
ALTER TABLE `acc_jobs` ADD `agent_id` text REFERENCES acc_agent_grants(id);