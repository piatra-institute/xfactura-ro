CREATE TABLE `acc_artifact_events` (
	`company_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`seq` integer NOT NULL,
	`state` text NOT NULL,
	`actor` text,
	`detail` text,
	`evidence_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `artifact_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`artifact_id`) REFERENCES `acc_artifacts`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_artifacts` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`period` text NOT NULL,
	`tax` text,
	`format` text NOT NULL,
	`input_hash` text NOT NULL,
	`evidence_id` text NOT NULL,
	`xml_hash` text NOT NULL,
	`supersedes_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifact_period` ON `acc_artifacts` (`company_id`,`kind`,`period`);