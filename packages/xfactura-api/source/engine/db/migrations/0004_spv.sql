CREATE TABLE `acc_spv_messages` (
	`company_id` text NOT NULL,
	`id` text NOT NULL,
	`upload_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at_anaf` integer NOT NULL,
	`details` text NOT NULL,
	`evidence_id` text,
	`document_id` text,
	`outcome` text NOT NULL,
	`detail` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`document_id`) REFERENCES `acc_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `spv_message_upload` ON `acc_spv_messages` (`company_id`,`upload_id`);--> statement-breakpoint
CREATE TABLE `acc_spv_sync_windows` (
	`company_id` text NOT NULL,
	`seq` integer NOT NULL,
	`from_ms` integer NOT NULL,
	`to_ms` integer NOT NULL,
	`messages` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spv_window" CHECK("acc_spv_sync_windows"."from_ms" < "acc_spv_sync_windows"."to_ms")
);
--> statement-breakpoint
CREATE TABLE `acc_submission_events` (
	`company_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`seq` integer NOT NULL,
	`state` text NOT NULL,
	`upload_id` text,
	`download_id` text,
	`detail` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `submission_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`submission_id`) REFERENCES `acc_submissions`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submission_upload` ON `acc_submission_events` (`company_id`,`upload_id`);--> statement-breakpoint
CREATE TABLE `acc_submissions` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`document_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`xml_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`document_id`) REFERENCES `acc_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submission_document` ON `acc_submissions` (`company_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `submission_xml` ON `acc_submissions` (`company_id`,`xml_hash`);