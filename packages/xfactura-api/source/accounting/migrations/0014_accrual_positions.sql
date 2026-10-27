CREATE TABLE `acc_accrual_matches` (
	`company_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`accrual_id` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	`deductible_tax_bani` integer NOT NULL,
	PRIMARY KEY(`company_id`, `invoice_id`, `accrual_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_invoice_postings`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`accrual_id`) REFERENCES `acc_accrual_postings`(`company_id`,`accrual_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "accrual_match_amounts" CHECK(typeof("acc_accrual_matches"."net_bani")='integer' and typeof("acc_accrual_matches"."tax_bani")='integer' and typeof("acc_accrual_matches"."gross_bani")='integer' and typeof("acc_accrual_matches"."deductible_tax_bani")='integer' and "acc_accrual_matches"."net_bani">0 and "acc_accrual_matches"."tax_bani">=0 and "acc_accrual_matches"."gross_bani"="acc_accrual_matches"."net_bani"+"acc_accrual_matches"."tax_bani" and "acc_accrual_matches"."deductible_tax_bani" between 0 and "acc_accrual_matches"."tax_bani")
);
--> statement-breakpoint
CREATE INDEX `accrual_match_position` ON `acc_accrual_matches` (`company_id`,`accrual_id`);--> statement-breakpoint
CREATE TABLE `acc_accrual_postings` (
	`company_id` text NOT NULL,
	`accrual_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`reference` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `accrual_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`accrual_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accrual_posting_journal` ON `acc_accrual_postings` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accrual_reference` ON `acc_accrual_postings` (`company_id`,`reference`);