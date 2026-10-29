CREATE TABLE `acc_bank_movements` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`treasury_account_id` text NOT NULL,
	`statement_id` text NOT NULL,
	`source_id` text NOT NULL,
	`booking_date` text NOT NULL,
	`value_date` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`reference` text NOT NULL,
	`counterparty` text,
	`counterparty_account` text,
	`details_json` text NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`treasury_account_id`) REFERENCES `acc_treasury_accounts`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`statement_id`) REFERENCES `acc_bank_statements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bank_movement_amount" CHECK("acc_bank_movements"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_movement_identity` ON `acc_bank_movements` (`company_id`,`treasury_account_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `bank_movement_date` ON `acc_bank_movements` (`company_id`,`treasury_account_id`,`booking_date`);--> statement-breakpoint
CREATE TABLE `acc_bank_statements` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`treasury_account_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`format` text NOT NULL,
	`source_id` text NOT NULL,
	`date_from` text NOT NULL,
	`date_to` text NOT NULL,
	`opening_minor` integer NOT NULL,
	`closing_minor` integer NOT NULL,
	`financial_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`treasury_account_id`) REFERENCES `acc_treasury_accounts`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_statement_identity` ON `acc_bank_statements` (`company_id`,`treasury_account_id`,`financial_hash`);--> statement-breakpoint
CREATE INDEX `bank_statement_period` ON `acc_bank_statements` (`company_id`,`treasury_account_id`,`date_to`);--> statement-breakpoint
CREATE TABLE `acc_treasury_accounts` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`iban` text,
	`currency` text NOT NULL,
	`ledger_account` text NOT NULL,
	`opened_on` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`ledger_account`) REFERENCES `acc_accounts`(`company_id`,`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `treasury_iban` ON `acc_treasury_accounts` (`company_id`,`iban`);--> statement-breakpoint
CREATE UNIQUE INDEX `treasury_ledger_account` ON `acc_treasury_accounts` (`company_id`,`ledger_account`);