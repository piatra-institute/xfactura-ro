CREATE TABLE `acc_deferral_postings` (
	`company_id` text NOT NULL,
	`deferral_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `deferral_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`deferral_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_invoice_postings`(`company_id`,`invoice_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_invoice` ON `acc_deferral_postings` (`company_id`,`invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_journal` ON `acc_deferral_postings` (`company_id`,`journal_id`);--> statement-breakpoint
CREATE TABLE `acc_deferral_releases` (
	`company_id` text NOT NULL,
	`deferral_id` text NOT NULL,
	`month` text NOT NULL,
	`proposal_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`amount_bani` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `deferral_id`, `month`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`deferral_id`) REFERENCES `acc_deferral_postings`(`company_id`,`deferral_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deferral_release_amount" CHECK(typeof("acc_deferral_releases"."amount_bani")='integer' and "acc_deferral_releases"."amount_bani">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_release_proposal` ON `acc_deferral_releases` (`company_id`,`proposal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_release_journal` ON `acc_deferral_releases` (`company_id`,`journal_id`);