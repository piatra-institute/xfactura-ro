CREATE TABLE `acc_deferral_reschedules` (
	`company_id` text NOT NULL,
	`id` text NOT NULL,
	`deferral_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`date` text NOT NULL,
	`evidence_id` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`id`) REFERENCES `acc_action_reviews`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`deferral_id`) REFERENCES `acc_deferral_postings`(`company_id`,`deferral_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deferral_reschedule_sequence_valid" CHECK(typeof("acc_deferral_reschedules"."sequence")='integer' and "acc_deferral_reschedules"."sequence" between 1 and 1000),
	CONSTRAINT "deferral_reschedule_body" CHECK(json_valid("acc_deferral_reschedules"."body") and json_extract("acc_deferral_reschedules"."body",'$.kind')='deferrals.reschedule' and json_extract("acc_deferral_reschedules"."body",'$.schemaVersion')=1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_reschedule_sequence` ON `acc_deferral_reschedules` (`company_id`,`deferral_id`,`sequence`);