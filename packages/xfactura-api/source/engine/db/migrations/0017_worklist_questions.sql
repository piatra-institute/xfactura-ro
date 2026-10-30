CREATE TABLE `acc_dispositions` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`disposition` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_by` text NOT NULL,
	`agent_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "disposition_value" CHECK("acc_dispositions"."disposition" in ('no_booking', 'dealt_with'))
);
--> statement-breakpoint
CREATE INDEX `disposition_subject` ON `acc_dispositions` (`company_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE TABLE `acc_question_answers` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`question_id` text NOT NULL,
	`seq` integer NOT NULL,
	`value_json` text NOT NULL,
	`evidence_id` text NOT NULL,
	`answered_by` text NOT NULL,
	`agent_id` text,
	`epoch` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answered_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`question_id`) REFERENCES `acc_questions`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_answer_seq` ON `acc_question_answers` (`company_id`,`question_id`,`seq`);--> statement-breakpoint
CREATE TABLE `acc_question_withdrawals` (
	`company_id` text NOT NULL,
	`question_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`agent_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `question_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`question_id`) REFERENCES `acc_questions`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_questions` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`params_json` text NOT NULL,
	`asked_by` text NOT NULL,
	`agent_id` text,
	`due` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `question_subject` ON `acc_questions` (`company_id`,`kind`,`subject_kind`,`subject_id`);--> statement-breakpoint
ALTER TABLE `acc_proposal_versions` ADD `basis_json` text;--> statement-breakpoint
CREATE INDEX `proposal_version_evidence` ON `acc_proposal_versions` (`company_id`,"input_json" ->> '$.evidenceId');--> statement-breakpoint
CREATE INDEX `proposal_version_created` ON `acc_proposal_versions` (`company_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `bank_statement_evidence` ON `acc_bank_statements` (`company_id`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `document_evidence` ON `acc_documents` (`company_id`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `fx_rate_evidence` ON `ref_fx_rates` (`evidence_hash`);--> statement-breakpoint
CREATE INDEX `party_status_evidence` ON `acc_party_status` (`company_id`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `profile_evidence` ON `acc_profile_facts` (`company_id`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `spv_message_outcome` ON `acc_spv_messages` (`company_id`,`outcome`);--> statement-breakpoint
CREATE INDEX `spv_message_evidence` ON `acc_spv_messages` (`company_id`,`evidence_id`);