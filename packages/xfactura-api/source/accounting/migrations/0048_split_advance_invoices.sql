PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acc_advance_invoice_matches` (
	`company_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `payment_id`, `invoice_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`payment_id`) REFERENCES `acc_advance_payments`(`company_id`,`payment_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_advance_invoices`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "advance_match_amounts" CHECK(typeof("__new_acc_advance_invoice_matches"."net_bani")='integer' and typeof("__new_acc_advance_invoice_matches"."tax_bani")='integer' and typeof("__new_acc_advance_invoice_matches"."gross_bani")='integer' and "__new_acc_advance_invoice_matches"."net_bani">0 and "__new_acc_advance_invoice_matches"."tax_bani">=0 and "__new_acc_advance_invoice_matches"."gross_bani"="__new_acc_advance_invoice_matches"."net_bani"+"__new_acc_advance_invoice_matches"."tax_bani")
);
--> statement-breakpoint
INSERT INTO `__new_acc_advance_invoice_matches`("company_id", "payment_id", "invoice_id", "journal_id", "net_bani", "tax_bani", "gross_bani", "created_by", "created_at") SELECT "company_id", "payment_id", "invoice_id", "journal_id", "net_bani", "tax_bani", "gross_bani", "created_by", "created_at" FROM `acc_advance_invoice_matches`;--> statement-breakpoint
DROP TABLE `acc_advance_invoice_matches`;--> statement-breakpoint
ALTER TABLE `__new_acc_advance_invoice_matches` RENAME TO `acc_advance_invoice_matches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `advance_matches_payment` ON `acc_advance_invoice_matches` (`company_id`,`payment_id`);--> statement-breakpoint
CREATE INDEX `advance_matches_invoice` ON `acc_advance_invoice_matches` (`company_id`,`invoice_id`);