CREATE TABLE `acc_bank_statement_entries` (
	`company_id` text NOT NULL,
	`id` text NOT NULL,
	`source_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`source_id`) REFERENCES `acc_bank_statement_sources`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bank_entry_ordinal" CHECK(typeof("acc_bank_statement_entries"."ordinal")='integer' and "acc_bank_statement_entries"."ordinal" between 0 and 1999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_entry_source_ordinal` ON `acc_bank_statement_entries` (`company_id`,`source_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `bank_entry_movement` ON `acc_bank_statement_entries` (`company_id`,`movement_id`);--> statement-breakpoint
CREATE TABLE `acc_bank_statement_files` (
	`company_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`financial_year_id` text NOT NULL,
	`format` text NOT NULL,
	`parser_version` text NOT NULL,
	`input_hash` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`statement_count` integer NOT NULL,
	`entry_count` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `evidence_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`financial_year_id`) REFERENCES `acc_accounting_years`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bank_file_format" CHECK("acc_bank_statement_files"."format" in ('mt940','camt.053') and "acc_bank_statement_files"."parser_version"='bank-statement-1'),
	CONSTRAINT "bank_file_manifest" CHECK(json_valid("acc_bank_statement_files"."manifest") and json_type("acc_bank_statement_files"."manifest")='array' and json_array_length("acc_bank_statement_files"."manifest")="acc_bank_statement_files"."statement_count"),
	CONSTRAINT "bank_file_counts" CHECK(typeof("acc_bank_statement_files"."statement_count")='integer' and "acc_bank_statement_files"."statement_count" between 1 and 100 and typeof("acc_bank_statement_files"."entry_count")='integer' and "acc_bank_statement_files"."entry_count" between 0 and 2000)
);
--> statement-breakpoint
CREATE TABLE `acc_bank_statement_sources` (
	`company_id` text NOT NULL,
	`id` text NOT NULL,
	`file_evidence_id` text NOT NULL,
	`statement_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`bank_account` text NOT NULL,
	`source_id` text NOT NULL,
	`financial_hash` text NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`file_evidence_id`) REFERENCES `acc_bank_statement_files`(`company_id`,`evidence_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`statement_id`) REFERENCES `acc_statements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bank_source_ordinal_valid" CHECK(typeof("acc_bank_statement_sources"."ordinal")='integer' and "acc_bank_statement_sources"."ordinal" between 0 and 99)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_source_ordinal` ON `acc_bank_statement_sources` (`company_id`,`file_evidence_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `bank_source_identity` ON `acc_bank_statement_sources` (`company_id`,`bank_account`,`source_id`);