CREATE TABLE `acc_garnishment_releases` (
	`company_id` text NOT NULL,
	`garnishment_id` text NOT NULL,
	`released_on` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `garnishment_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`garnishment_id`) REFERENCES `acc_garnishments`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_garnishments` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`contract_id` text NOT NULL,
	`party_id` text NOT NULL,
	`kind` text NOT NULL,
	`reference` text NOT NULL,
	`received_on` text NOT NULL,
	`total_bani` integer NOT NULL,
	`monthly_bani` integer,
	`share_numerator` integer,
	`share_denominator` integer,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `garnishment_contract` ON `acc_garnishments` (`company_id`,`contract_id`);--> statement-breakpoint
CREATE TABLE `acc_reges_records` (
	`company_id` text NOT NULL,
	`contract_id` text NOT NULL,
	`terms_seq` integer NOT NULL,
	`event` text NOT NULL,
	`transmitted_on` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `contract_id`, `terms_seq`, `event`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`contract_id`,`terms_seq`) REFERENCES `acc_employment_terms`(`company_id`,`contract_id`,`seq`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `acc_employment_terms` ADD `kind` text DEFAULT 'employment' NOT NULL;--> statement-breakpoint
ALTER TABLE `acc_payroll_runs` ADD `corrects_run_id` text;--> statement-breakpoint
ALTER TABLE `acc_payroll_runs` ADD `correction_reason` text;--> statement-breakpoint
ALTER TABLE `acc_payroll_runs` ADD `correction_evidence_id` text;