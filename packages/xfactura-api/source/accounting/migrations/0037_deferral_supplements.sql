CREATE TABLE `acc_deferral_supplements` (
	`company_id` text NOT NULL,
	`deferral_id` text NOT NULL,
	`parent_deferral_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `deferral_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`deferral_id`) REFERENCES `acc_deferral_postings`(`company_id`,`deferral_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`parent_deferral_id`) REFERENCES `acc_deferral_postings`(`company_id`,`deferral_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deferral_supplement_distinct" CHECK("acc_deferral_supplements"."deferral_id"<>"acc_deferral_supplements"."parent_deferral_id")
);
--> statement-breakpoint
CREATE INDEX `deferral_supplement_parent` ON `acc_deferral_supplements` (`company_id`,`parent_deferral_id`,`deferral_id`);