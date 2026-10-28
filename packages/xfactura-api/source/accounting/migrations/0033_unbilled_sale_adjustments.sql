CREATE TABLE `acc_unbilled_sale_adjustments` (
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`unbilled_sale_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`reference` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `proposal_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`unbilled_sale_id`) REFERENCES `acc_unbilled_sale_postings`(`company_id`,`unbilled_sale_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "unbilled_sale_adjustment_amounts" CHECK(typeof("acc_unbilled_sale_adjustments"."net_bani")='integer' and typeof("acc_unbilled_sale_adjustments"."tax_bani")='integer' and typeof("acc_unbilled_sale_adjustments"."gross_bani")='integer' and "acc_unbilled_sale_adjustments"."gross_bani"="acc_unbilled_sale_adjustments"."net_bani"+"acc_unbilled_sale_adjustments"."tax_bani" and ("acc_unbilled_sale_adjustments"."net_bani"<>0 or "acc_unbilled_sale_adjustments"."tax_bani"<>0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unbilled_sale_adjustment_journal` ON `acc_unbilled_sale_adjustments` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `unbilled_sale_adjustment_reference` ON `acc_unbilled_sale_adjustments` (`company_id`,`reference`);--> statement-breakpoint
CREATE INDEX `unbilled_sale_adjustment_position` ON `acc_unbilled_sale_adjustments` (`company_id`,`unbilled_sale_id`);