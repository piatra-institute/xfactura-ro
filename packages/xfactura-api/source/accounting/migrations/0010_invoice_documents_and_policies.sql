CREATE TABLE `acc_accounting_policies` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`effective_from` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "policy_version_positive" CHECK("acc_accounting_policies"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_version` ON `acc_accounting_policies` (`company_id`,`key`,`version`);--> statement-breakpoint
CREATE TABLE `acc_invoice_documents` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`direction` text NOT NULL,
	`source_key` text NOT NULL,
	`hash` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_source` ON `acc_invoice_documents` (`company_id`,`source_key`);