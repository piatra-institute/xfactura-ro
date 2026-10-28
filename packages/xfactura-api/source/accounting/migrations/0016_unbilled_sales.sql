CREATE TABLE `acc_unbilled_sale_matches` (
	`company_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`unbilled_sale_id` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	PRIMARY KEY(`company_id`, `invoice_id`, `unbilled_sale_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_invoice_postings`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`unbilled_sale_id`) REFERENCES `acc_unbilled_sale_postings`(`company_id`,`unbilled_sale_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "unbilled_sale_match_amounts" CHECK(typeof("acc_unbilled_sale_matches"."net_bani")='integer' and typeof("acc_unbilled_sale_matches"."tax_bani")='integer' and typeof("acc_unbilled_sale_matches"."gross_bani")='integer' and "acc_unbilled_sale_matches"."net_bani">0 and "acc_unbilled_sale_matches"."tax_bani">=0 and "acc_unbilled_sale_matches"."gross_bani"="acc_unbilled_sale_matches"."net_bani"+"acc_unbilled_sale_matches"."tax_bani")
);
--> statement-breakpoint
CREATE INDEX `unbilled_sale_match_position` ON `acc_unbilled_sale_matches` (`company_id`,`unbilled_sale_id`);--> statement-breakpoint
CREATE TABLE `acc_unbilled_sale_postings` (
	`company_id` text NOT NULL,
	`unbilled_sale_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`reference` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `unbilled_sale_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`unbilled_sale_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unbilled_sale_journal` ON `acc_unbilled_sale_postings` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `unbilled_sale_reference` ON `acc_unbilled_sale_postings` (`company_id`,`reference`);