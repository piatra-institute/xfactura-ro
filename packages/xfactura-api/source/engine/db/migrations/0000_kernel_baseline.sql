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
CREATE INDEX `account_user` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `acc_action_decisions` (
	`company_id` text NOT NULL,
	`request_id` text NOT NULL,
	`decision` text NOT NULL,
	`preview_hash` text NOT NULL,
	`decided_by` text NOT NULL,
	`decided_epoch` integer NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `request_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`request_id`) REFERENCES `acc_action_requests`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_action_executions` (
	`company_id` text NOT NULL,
	`request_id` text NOT NULL,
	`result_json` text NOT NULL,
	`executed_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `request_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`executed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`request_id`) REFERENCES `acc_action_decisions`(`company_id`,`request_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_action_requests` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`operation` text NOT NULL,
	`input_json` text NOT NULL,
	`preview_json` text NOT NULL,
	`preview_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`agent_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_agent_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`membership_epoch` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`created_by`) REFERENCES `acc_memberships`(`company_id`,`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acc_agent_grants_token_hash_unique` ON `acc_agent_grants` (`token_hash`);--> statement-breakpoint
CREATE INDEX `agent_grant_company` ON `acc_agent_grants` (`company_id`,`id`);--> statement-breakpoint
CREATE TABLE `acc_approvals` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`version` integer NOT NULL,
	`effect_hash` text NOT NULL,
	`approver_id` text NOT NULL,
	`approver_epoch` integer NOT NULL,
	`acknowledgements_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approver_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`,`version`) REFERENCES `acc_proposal_versions`(`company_id`,`proposal_id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_version` ON `acc_approvals` (`company_id`,`proposal_id`,`version`);--> statement-breakpoint
CREATE TABLE `acc_audit` (
	`company_id` text NOT NULL,
	`seq` integer NOT NULL,
	`actor_id` text NOT NULL,
	`agent_id` text,
	`action` text NOT NULL,
	`body_json` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
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
	`country` text DEFAULT 'RO' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "company_cui" CHECK("acc_companies"."cui" glob '[0-9]*' and length("acc_companies"."cui") between 2 and 10)
);
--> statement-breakpoint
CREATE TABLE `acc_document_links` (
	`company_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `from_id`, `to_id`, `kind`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`from_id`) REFERENCES `acc_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`to_id`) REFERENCES `acc_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_documents` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`schema` text NOT NULL,
	`body_json` text NOT NULL,
	`body_hash` text NOT NULL,
	`source_key` text NOT NULL,
	`evidence_id` text,
	`origin` text NOT NULL,
	`doc_date` text NOT NULL,
	`party_id` text,
	`currency` text,
	`number` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_source` ON `acc_documents` (`company_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `document_date` ON `acc_documents` (`company_id`,`doc_date`);--> statement-breakpoint
CREATE TABLE `acc_entries` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`fiscal_year_id` text NOT NULL,
	`journal_class` text NOT NULL,
	`journal_code` text NOT NULL,
	`number` integer NOT NULL,
	`seq` integer NOT NULL,
	`date` text NOT NULL,
	`period` text NOT NULL,
	`description` text NOT NULL,
	`proposal_id` text NOT NULL,
	`version` integer NOT NULL,
	`approval_id` text,
	`policy_id` text,
	`posted_by` text NOT NULL,
	`agent_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`posted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`fiscal_year_id`) REFERENCES `acc_fiscal_years`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`,`version`) REFERENCES `acc_proposal_versions`(`company_id`,`proposal_id`,`version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`approval_id`) REFERENCES `acc_approvals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`policy_id`) REFERENCES `acc_posting_policies`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entry_binding" CHECK(("acc_entries"."approval_id" is null) <> ("acc_entries"."policy_id" is null)),
	CONSTRAINT "entry_period_value" CHECK("acc_entries"."period" = substr("acc_entries"."date", 1, 7))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entry_proposal` ON `acc_entries` (`company_id`,`proposal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entry_number` ON `acc_entries` (`company_id`,`fiscal_year_id`,`journal_class`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `entry_seq` ON `acc_entries` (`company_id`,`seq`);--> statement-breakpoint
CREATE INDEX `entry_period` ON `acc_entries` (`company_id`,`period`);--> statement-breakpoint
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
	CONSTRAINT "evidence_size" CHECK("acc_evidence"."size" between 1 and 67108864),
	CONSTRAINT "evidence_hash" CHECK(length("acc_evidence"."hash")=64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_content` ON `acc_evidence` (`company_id`,`hash`);--> statement-breakpoint
CREATE TABLE `acc_fiscal_years` (
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
	CONSTRAINT "fiscal_year_dates" CHECK("acc_fiscal_years"."date_from" <= "acc_fiscal_years"."date_to")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fiscal_year_start` ON `acc_fiscal_years` (`company_id`,`kind`,`date_from`);--> statement-breakpoint
CREATE TABLE `ref_fx_rates` (
	`source` text NOT NULL,
	`currency` text NOT NULL,
	`rate_date` text NOT NULL,
	`revision` integer NOT NULL,
	`rate` text NOT NULL,
	`multiplier` integer NOT NULL,
	`published_at` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`source`, `currency`, `rate_date`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `acc_invariants` (
	`name` text PRIMARY KEY NOT NULL,
	`checksum` text NOT NULL
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
	`agent_id` text,
	`kind` text NOT NULL,
	`params` text NOT NULL,
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
CREATE INDEX `job_pending` ON `acc_jobs` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `acc_accounts` (
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`parent_code` text,
	`name` text NOT NULL,
	`nature` text NOT NULL,
	`book` text NOT NULL,
	`postable` integer NOT NULL,
	`control_kind` text,
	`saft_account` text,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`chart_version` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `code`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "account_validity" CHECK("acc_accounts"."valid_to" is null or "acc_accounts"."valid_from" <= "acc_accounts"."valid_to")
);
--> statement-breakpoint
CREATE TABLE `acc_lines` (
	`company_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`account` text NOT NULL,
	`side` text NOT NULL,
	`bani` integer NOT NULL,
	`currency` text,
	`currency_minor` integer,
	`fx_rate_id` text,
	`fx_rate` text,
	`party_id` text,
	`open_item_id` text,
	`tax_settlement_tax` text,
	`tax_settlement_period` text,
	`cost_center` text,
	`project` text,
	`item` text,
	`memo` text,
	PRIMARY KEY(`company_id`, `entry_id`, `line_no`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`entry_id`) REFERENCES `acc_entries`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`account`) REFERENCES `acc_accounts`(`company_id`,`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`open_item_id`) REFERENCES `acc_open_items`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "line_amount" CHECK("acc_lines"."bani" <> 0),
	CONSTRAINT "line_currency" CHECK(("acc_lines"."currency" is null) = ("acc_lines"."currency_minor" is null))
);
--> statement-breakpoint
CREATE INDEX `line_account` ON `acc_lines` (`company_id`,`account`,`entry_id`);--> statement-breakpoint
CREATE INDEX `line_open_item` ON `acc_lines` (`company_id`,`open_item_id`);--> statement-breakpoint
CREATE INDEX `line_party` ON `acc_lines` (`company_id`,`party_id`);--> statement-breakpoint
CREATE TABLE `acc_memberships` (
	`company_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`company_id`, `user_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "membership_role" CHECK("acc_memberships"."role" in ('owner','reviewer','viewer'))
);
--> statement-breakpoint
CREATE TABLE `acc_open_items` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`control_account` text NOT NULL,
	`party_id` text NOT NULL,
	`currency` text NOT NULL,
	`normal_side` text NOT NULL,
	`may_reverse` integer NOT NULL,
	`due_date` text,
	`document_id` text,
	`origin_entry_id` text NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`origin_entry_id`) REFERENCES `acc_entries`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `open_item_origin` ON `acc_open_items` (`company_id`,`origin_entry_id`);--> statement-breakpoint
CREATE INDEX `open_item_party` ON `acc_open_items` (`company_id`,`party_id`,`kind`);--> statement-breakpoint
CREATE INDEX `open_item_document` ON `acc_open_items` (`company_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `acc_outbox` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_id` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`result` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outbox_pending` ON `acc_outbox` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `acc_parties` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`country` text NOT NULL,
	`tax_id` text,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `party_identity` ON `acc_parties` (`company_id`,`country`,`tax_id`);--> statement-breakpoint
CREATE TABLE `acc_period_balances` (
	`company_id` text NOT NULL,
	`month` text NOT NULL,
	`close_seq` integer NOT NULL,
	`account` text NOT NULL,
	`currency` text NOT NULL,
	`debit_turnover` integer NOT NULL,
	`credit_turnover` integer NOT NULL,
	`closing_bani` integer NOT NULL,
	`closing_minor` integer NOT NULL,
	PRIMARY KEY(`company_id`, `month`, `close_seq`, `account`, `currency`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`month`,`close_seq`) REFERENCES `acc_period_events`(`company_id`,`month`,`seq`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_period_events` (
	`company_id` text NOT NULL,
	`month` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`action_id` text NOT NULL,
	`watermark_seq` integer NOT NULL,
	`snapshot_hash` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `month`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`action_id`) REFERENCES `acc_action_requests`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_policy_revocations` (
	`company_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `policy_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`policy_id`) REFERENCES `acc_posting_policies`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_posting_policies` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`treatments_json` text NOT NULL,
	`rules_hashes_json` text NOT NULL,
	`preconditions_json` text NOT NULL,
	`approved_by` text NOT NULL,
	`approver_epoch` integer NOT NULL,
	`valid_from` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_profile_facts` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`axis` text NOT NULL,
	`value` text NOT NULL,
	`effective_from` text NOT NULL,
	`evidence_id` text NOT NULL,
	`supersedes_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `profile_axis` ON `acc_profile_facts` (`company_id`,`axis`,`effective_from`);--> statement-breakpoint
CREATE TABLE `acc_proposal_versions` (
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`version` integer NOT NULL,
	`treatment_version` integer NOT NULL,
	`input_json` text NOT NULL,
	`read_set_json` text NOT NULL,
	`rules_json` text NOT NULL,
	`rules_hash` text NOT NULL,
	`effect_json` text,
	`issues_json` text NOT NULL,
	`blocking` integer NOT NULL,
	`effect_hash` text NOT NULL,
	`entry_date` text,
	`created_by` text NOT NULL,
	`agent_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `proposal_id`, `version`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proposal_effect" CHECK("acc_proposal_versions"."blocking" = 1 or "acc_proposal_versions"."effect_json" is not null)
);
--> statement-breakpoint
CREATE TABLE `acc_proposals` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`treatment_id` text NOT NULL,
	`subject_key` text NOT NULL,
	`document_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`document_id`) REFERENCES `acc_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_subject` ON `acc_proposals` (`company_id`,`subject_key`);--> statement-breakpoint
CREATE TABLE `acc_schedule_rows` (
	`company_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`version` integer NOT NULL,
	`row_key` text NOT NULL,
	`entry_id` text NOT NULL,
	`open_item_id` text NOT NULL,
	`method` text NOT NULL,
	`due_date` text NOT NULL,
	`bani` integer NOT NULL,
	`counter_account` text NOT NULL,
	PRIMARY KEY(`company_id`, `schedule_id`, `version`, `row_key`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`entry_id`) REFERENCES `acc_entries`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`open_item_id`) REFERENCES `acc_open_items`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "schedule_amount" CHECK("acc_schedule_rows"."bani" > 0)
);
--> statement-breakpoint
CREATE INDEX `schedule_entry` ON `acc_schedule_rows` (`company_id`,`entry_id`);--> statement-breakpoint
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
CREATE INDEX `session_user` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `acc_tax_entries` (
	`company_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`tax_no` integer NOT NULL,
	`key` text NOT NULL,
	`line_no` integer,
	`tax` text NOT NULL,
	`code` text NOT NULL,
	`direction` text NOT NULL,
	`base_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`deductible_bani` integer NOT NULL,
	`ledger_bani` integer NOT NULL,
	`tax_point` text NOT NULL,
	`exigibility` text,
	`tax_period` text,
	`party_id` text,
	`document_id` text,
	`origin_tax_entry` text,
	`currency` text,
	`base_minor` integer,
	`tax_minor` integer,
	`fx_rate_id` text,
	`fx_rate` text,
	`attributes_json` text NOT NULL,
	PRIMARY KEY(`company_id`, `entry_id`, `tax_no`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`entry_id`) REFERENCES `acc_entries`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tax_entry_ledger" CHECK("acc_tax_entries"."line_no" is not null or "acc_tax_entries"."ledger_bani" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_entry_key` ON `acc_tax_entries` (`company_id`,`entry_id`,`key`);--> statement-breakpoint
CREATE INDEX `tax_entry_period` ON `acc_tax_entries` (`company_id`,`tax`,`tax_period`);--> statement-breakpoint
CREATE TABLE `acc_tax_period_events` (
	`company_id` text NOT NULL,
	`tax` text NOT NULL,
	`period` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`reference` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `tax`, `period`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `acc_withdrawals` (
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `proposal_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
