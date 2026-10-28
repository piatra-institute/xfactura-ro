CREATE TABLE `acc_accrual_adjustments` (
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`accrual_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`reference` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	`deferred_tax_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `proposal_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`accrual_id`) REFERENCES `acc_accrual_postings`(`company_id`,`accrual_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "accrual_adjustment_amounts" CHECK(typeof("acc_accrual_adjustments"."net_bani")='integer' and typeof("acc_accrual_adjustments"."tax_bani")='integer' and typeof("acc_accrual_adjustments"."gross_bani")='integer' and typeof("acc_accrual_adjustments"."deferred_tax_bani")='integer' and "acc_accrual_adjustments"."gross_bani"="acc_accrual_adjustments"."net_bani"+"acc_accrual_adjustments"."tax_bani" and ("acc_accrual_adjustments"."net_bani"<>0 or "acc_accrual_adjustments"."tax_bani"<>0) and ("acc_accrual_adjustments"."deferred_tax_bani"=0 or "acc_accrual_adjustments"."deferred_tax_bani"="acc_accrual_adjustments"."tax_bani"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accrual_adjustment_journal` ON `acc_accrual_adjustments` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accrual_adjustment_reference` ON `acc_accrual_adjustments` (`company_id`,`reference`);--> statement-breakpoint
CREATE INDEX `accrual_adjustment_position` ON `acc_accrual_adjustments` (`company_id`,`accrual_id`);