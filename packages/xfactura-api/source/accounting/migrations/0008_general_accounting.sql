CREATE TABLE `acc_accounting_years` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`date_from` text NOT NULL,
	`date_to` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "accounting_year_dates" CHECK("acc_accounting_years"."date_from" <= "acc_accounting_years"."date_to")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounting_year_start` ON `acc_accounting_years` (`company_id`,`kind`,`date_from`);--> statement-breakpoint
CREATE TABLE `acc_ledger_accounts` (
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`parent_code` text,
	`balance` text NOT NULL,
	`book` text NOT NULL,
	`postable` integer NOT NULL,
	`chart_version` text NOT NULL,
	`valid_from` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `code`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_regime_events` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`axis` text NOT NULL,
	`value` text NOT NULL,
	`effective_from` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `regime_effective_event` ON `acc_regime_events` (`company_id`,`axis`,`effective_from`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acc_journal_lines` (
	`company_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`line` integer NOT NULL,
	`account` text NOT NULL,
	`debit_bani` integer NOT NULL,
	`credit_bani` integer NOT NULL,
	PRIMARY KEY(`company_id`, `journal_id`, `line`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "integer_amounts" CHECK(typeof("__new_acc_journal_lines"."debit_bani")='integer' and typeof("__new_acc_journal_lines"."credit_bani")='integer'),
	CONSTRAINT "single_sided_line" CHECK(("__new_acc_journal_lines"."debit_bani">0 and "__new_acc_journal_lines"."credit_bani"=0) or ("__new_acc_journal_lines"."credit_bani">0 and "__new_acc_journal_lines"."debit_bani"=0))
);
--> statement-breakpoint
INSERT INTO `__new_acc_journal_lines`("company_id", "journal_id", "line", "account", "debit_bani", "credit_bani") SELECT "company_id", "journal_id", "line", "account", "debit_bani", "credit_bani" FROM `acc_journal_lines`;--> statement-breakpoint
DROP TABLE `acc_journal_lines`;--> statement-breakpoint
ALTER TABLE `__new_acc_journal_lines` RENAME TO `acc_journal_lines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;