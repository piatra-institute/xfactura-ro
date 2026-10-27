CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`scope` text,
	`password` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounting_account_user` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `acc_allocations` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`amount_bani` integer NOT NULL,
	`journal_id` text NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "positive_allocation" CHECK("acc_allocations"."amount_bani">0 and typeof("acc_allocations"."amount_bani")='integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movement_allocation` ON `acc_allocations` (`company_id`,`movement_id`);--> statement-breakpoint
CREATE TABLE `acc_approvals` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`version` integer NOT NULL,
	`hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_version` ON `acc_approvals` (`company_id`,`proposal_id`,`version`);--> statement-breakpoint
CREATE TABLE `acc_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_bank_accounts` (
	`company_id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_commands` (
	`company_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`key` text NOT NULL,
	`operation` text NOT NULL,
	`hash` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `actor_id`, `key`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cui` text NOT NULL,
	`year` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "company_year" CHECK("acc_companies"."year" between 2020 and 2100)
);
--> statement-breakpoint
CREATE TABLE `acc_evidence` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`hash` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evidence_size" CHECK("acc_evidence"."size" between 1 and 10485760),
	CONSTRAINT "evidence_hash" CHECK(length("acc_evidence"."hash")=64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_content` ON `acc_evidence` (`company_id`,`hash`);--> statement-breakpoint
CREATE TABLE `acc_facts` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`supersedes_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_fiscal_interpretations` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`fact_id` text NOT NULL,
	`position_id` text NOT NULL,
	`status` text DEFAULT 'PENDING_REVIEW' NOT NULL,
	`affects_posting` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`fact_id`) REFERENCES `acc_facts`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`position_id`) REFERENCES `acc_tax_positions`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acc_invitations_token_hash_unique` ON `acc_invitations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `acc_jobs` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_exports` ON `acc_jobs` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `acc_journal_lines` (
	`company_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`line` integer NOT NULL,
	`account` text NOT NULL,
	`debit_bani` integer NOT NULL,
	`credit_bani` integer NOT NULL,
	PRIMARY KEY(`company_id`, `journal_id`, `line`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "line_account" CHECK("acc_journal_lines"."account" in ('1012','401','5121','628')),
	CONSTRAINT "integer_amounts" CHECK(typeof("acc_journal_lines"."debit_bani")='integer' and typeof("acc_journal_lines"."credit_bani")='integer'),
	CONSTRAINT "single_sided_line" CHECK(("acc_journal_lines"."debit_bani">0 and "acc_journal_lines"."credit_bani"=0) or ("acc_journal_lines"."credit_bani">0 and "acc_journal_lines"."debit_bani"=0))
);
--> statement-breakpoint
CREATE TABLE `acc_journals` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`number` integer NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`approval_id` text,
	`evidence_id` text NOT NULL,
	`description` text NOT NULL,
	`lines_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`approval_id`) REFERENCES `acc_approvals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "journal_lines_json" CHECK(json_valid("acc_journals"."lines_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_number` ON `acc_journals` (`company_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `journal_source` ON `acc_journals` (`company_id`,`kind`,`source_id`);--> statement-breakpoint
CREATE TABLE `acc_memberships` (
	`company_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`company_id`, `user_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "membership_role" CHECK("acc_memberships"."role" in ('owner','reviewer','viewer'))
);
--> statement-breakpoint
CREATE TABLE `acc_movements` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`bank_account` text NOT NULL,
	`source_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_bani` integer NOT NULL,
	`reference` text NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movement_source` ON `acc_movements` (`company_id`,`bank_account`,`source_id`);--> statement-breakpoint
CREATE TABLE `acc_periods` (
	`company_id` text NOT NULL,
	`month` text NOT NULL,
	`closed_at` text,
	`closed_by` text,
	PRIMARY KEY(`company_id`, `month`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_proposals` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`fact_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`hash` text NOT NULL,
	`body` text NOT NULL,
	`source_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`fact_id`) REFERENCES `acc_facts`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_source` ON `acc_proposals` (`company_id`,`source_key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `accounting_session_user` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `acc_statement_movements` (
	`company_id` text NOT NULL,
	`statement_id` text NOT NULL,
	`movement_id` text NOT NULL,
	PRIMARY KEY(`company_id`, `statement_id`, `movement_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`statement_id`) REFERENCES `acc_statements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movements`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_statements` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`bank_account` text NOT NULL,
	`source_id` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`opening_bani` integer NOT NULL,
	`closing_bani` integer NOT NULL,
	`hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_source` ON `acc_statements` (`company_id`,`bank_account`,`source_id`);--> statement-breakpoint
CREATE TABLE `acc_tax_positions` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'PENDING_REVIEW' NOT NULL,
	`package_id` text DEFAULT 'draft-a1' NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_position_revision` ON `acc_tax_positions` (`company_id`,`period_from`,`revision`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
