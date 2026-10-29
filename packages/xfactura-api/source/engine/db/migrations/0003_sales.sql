CREATE TABLE `acc_issued_numbers` (
	`company_id` text NOT NULL,
	`series_id` text NOT NULL,
	`number` integer NOT NULL,
	`type_code` text NOT NULL,
	`issue_date` text NOT NULL,
	`document_id` text NOT NULL,
	`seller_version` integer NOT NULL,
	`buyer_version` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `series_id`, `number`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`series_id`) REFERENCES `acc_series`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`document_id`) REFERENCES `acc_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issued_document` ON `acc_issued_numbers` (`company_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `acc_party_versions` (
	`company_id` text NOT NULL,
	`party_id` text NOT NULL,
	`version` integer NOT NULL,
	`details_json` text NOT NULL,
	`details_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `party_id`, `version`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_series` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`prefix` text NOT NULL,
	`width` integer NOT NULL,
	`first_number` integer NOT NULL,
	`type_codes_json` text NOT NULL,
	`revenue_account` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "series_width" CHECK("acc_series"."width" between 1 and 12),
	CONSTRAINT "series_first" CHECK("acc_series"."first_number" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_code` ON `acc_series` (`company_id`,`code`);--> statement-breakpoint
CREATE INDEX `document_number` ON `acc_documents` (`company_id`,`number`);