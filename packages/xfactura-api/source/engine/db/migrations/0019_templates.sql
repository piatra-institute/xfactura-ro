CREATE TABLE `acc_template_predictions` (
	`company_id` text NOT NULL,
	`template_id` text NOT NULL,
	`template_version` integer NOT NULL,
	`source_key` text NOT NULL,
	`status` text NOT NULL,
	`subject_key` text,
	`input_json` text,
	`fingerprint` text,
	`as_of_seq` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `template_id`, `template_version`, `source_key`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`template_id`,`template_version`) REFERENCES `acc_templates`(`company_id`,`id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "template_prediction_status" CHECK("acc_template_predictions"."status" in ('predicted', 'not_applicable', 'blocked') and ("acc_template_predictions"."status" = 'predicted') = ("acc_template_predictions"."fingerprint" is not null) and ("acc_template_predictions"."status" = 'not_applicable') = ("acc_template_predictions"."subject_key" is null))
);
--> statement-breakpoint
CREATE INDEX `template_prediction_subject` ON `acc_template_predictions` (`company_id`,`subject_key`);--> statement-breakpoint
CREATE TABLE `acc_template_revocations` (
	`company_id` text NOT NULL,
	`template_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `template_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_templates` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`treatment_id` text NOT NULL,
	`party_id` text,
	`document_kind` text NOT NULL,
	`scope_json` text NOT NULL,
	`mapping_json` text NOT NULL,
	`request_id` text NOT NULL,
	`approved_by` text NOT NULL,
	`approver_epoch` integer NOT NULL,
	`created_by` text NOT NULL,
	`agent_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`, `version`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`request_id`) REFERENCES `acc_action_requests`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `template_scope` ON `acc_templates` (`company_id`,`treatment_id`,`party_id`);--> statement-breakpoint
ALTER TABLE `acc_proposal_versions` ADD `fingerprint` text;