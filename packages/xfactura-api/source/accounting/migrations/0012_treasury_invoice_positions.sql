CREATE TABLE `acc_invoice_credits` (
	`company_id` text NOT NULL,
	`credit_invoice_id` text NOT NULL,
	`original_invoice_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	`deductible_tax_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `credit_invoice_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`credit_invoice_id`) REFERENCES `acc_invoice_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`original_invoice_id`) REFERENCES `acc_invoice_postings`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_credit_totals" CHECK("acc_invoice_credits"."net_bani">0 and "acc_invoice_credits"."tax_bani">=0 and "acc_invoice_credits"."gross_bani"="acc_invoice_credits"."net_bani"+"acc_invoice_credits"."tax_bani" and "acc_invoice_credits"."deductible_tax_bani" between 0 and "acc_invoice_credits"."tax_bani")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_credit_journal` ON `acc_invoice_credits` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE INDEX `invoice_credit_original` ON `acc_invoice_credits` (`company_id`,`original_invoice_id`);--> statement-breakpoint
CREATE TABLE `acc_invoice_postings` (
	`company_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `invoice_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_invoice_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_posting_journal` ON `acc_invoice_postings` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_posting_proposal` ON `acc_invoice_postings` (`company_id`,`proposal_id`);--> statement-breakpoint
CREATE TABLE `acc_invoice_settlements` (
	`company_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`cleared_bani` integer NOT NULL,
	PRIMARY KEY(`company_id`, `movement_id`, `invoice_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movement_postings`(`company_id`,`movement_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_invoice_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "settlement_amount" CHECK(typeof("acc_invoice_settlements"."cleared_bani")='integer' and "acc_invoice_settlements"."cleared_bani"<>0)
);
--> statement-breakpoint
CREATE TABLE `acc_movement_postings` (
	`company_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `movement_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movement_posting_journal` ON `acc_movement_postings` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE TABLE `acc_movement_sources` (
	`company_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	PRIMARY KEY(`company_id`, `movement_id`, `evidence_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_treasury_accounts` (
	`company_id` text NOT NULL,
	`identifier` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`ledger_account` text NOT NULL,
	`opened_on` text NOT NULL,
	`evidence_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `identifier`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`ledger_account`) REFERENCES `acc_ledger_accounts`(`company_id`,`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "treasury_ron" CHECK("acc_treasury_accounts"."currency"='RON')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `treasury_ledger_account` ON `acc_treasury_accounts` (`company_id`,`ledger_account`);