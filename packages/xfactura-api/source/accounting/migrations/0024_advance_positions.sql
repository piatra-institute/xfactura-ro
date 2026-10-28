CREATE TABLE `acc_advance_invoice_matches` (
	`company_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `payment_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`payment_id`) REFERENCES `acc_advance_payments`(`company_id`,`payment_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_advance_invoices`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "advance_match_amounts" CHECK(typeof("acc_advance_invoice_matches"."net_bani")='integer' and typeof("acc_advance_invoice_matches"."tax_bani")='integer' and typeof("acc_advance_invoice_matches"."gross_bani")='integer' and "acc_advance_invoice_matches"."net_bani">0 and "acc_advance_invoice_matches"."tax_bani">=0 and "acc_advance_invoice_matches"."gross_bani"="acc_advance_invoice_matches"."net_bani"+"acc_advance_invoice_matches"."tax_bani")
);
--> statement-breakpoint
CREATE INDEX `advance_matches_invoice` ON `acc_advance_invoice_matches` (`company_id`,`invoice_id`);--> statement-breakpoint
CREATE TABLE `acc_advance_invoices` (
	`company_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `invoice_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_invoice_postings`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advance_invoice_proposal` ON `acc_advance_invoices` (`company_id`,`proposal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `advance_invoice_journal` ON `acc_advance_invoices` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE TABLE `acc_advance_payments` (
	`company_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `payment_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`payment_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movement_postings`(`company_id`,`movement_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advance_payment_movement` ON `acc_advance_payments` (`company_id`,`movement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `advance_payment_journal` ON `acc_advance_payments` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE TABLE `acc_advance_refunds` (
	`company_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `payment_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`payment_id`) REFERENCES `acc_advance_payments`(`company_id`,`payment_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movement_postings`(`company_id`,`movement_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advance_refund_movement` ON `acc_advance_refunds` (`company_id`,`movement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `advance_refund_journal` ON `acc_advance_refunds` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE TABLE `acc_advance_uses` (
	`company_id` text NOT NULL,
	`advance_invoice_id` text NOT NULL,
	`final_invoice_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`line_id` text NOT NULL,
	`net_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`gross_bani` integer NOT NULL,
	`control_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `final_invoice_id`, `advance_invoice_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`advance_invoice_id`) REFERENCES `acc_advance_invoices`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`final_invoice_id`) REFERENCES `acc_invoice_postings`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "advance_use_amounts" CHECK(typeof("acc_advance_uses"."net_bani")='integer' and typeof("acc_advance_uses"."tax_bani")='integer' and typeof("acc_advance_uses"."gross_bani")='integer' and typeof("acc_advance_uses"."control_bani")='integer' and "acc_advance_uses"."net_bani">0 and "acc_advance_uses"."tax_bani">=0 and "acc_advance_uses"."gross_bani"="acc_advance_uses"."net_bani"+"acc_advance_uses"."tax_bani" and "acc_advance_uses"."control_bani">0)
);
--> statement-breakpoint
CREATE INDEX `advance_uses_source` ON `acc_advance_uses` (`company_id`,`advance_invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `advance_use_line` ON `acc_advance_uses` (`company_id`,`final_invoice_id`,`line_id`);