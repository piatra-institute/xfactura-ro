CREATE TABLE `acc_deferral_cancellations` (
	`company_id` text NOT NULL,
	`deferral_id` text NOT NULL,
	`credit_invoice_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`from_month` text NOT NULL,
	`to_month` text NOT NULL,
	`amount_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `credit_invoice_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`deferral_id`) REFERENCES `acc_deferral_postings`(`company_id`,`deferral_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`credit_invoice_id`) REFERENCES `acc_invoice_credits`(`company_id`,`credit_invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deferral_cancellation_amount" CHECK(typeof("acc_deferral_cancellations"."amount_bani")='integer' and "acc_deferral_cancellations"."amount_bani">0),
	CONSTRAINT "deferral_cancellation_months" CHECK("acc_deferral_cancellations"."from_month"<="acc_deferral_cancellations"."to_month")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_cancellation_source` ON `acc_deferral_cancellations` (`company_id`,`deferral_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_cancellation_journal` ON `acc_deferral_cancellations` (`company_id`,`journal_id`);