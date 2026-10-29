CREATE TABLE `acc_asset_events` (
	`company_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `asset_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`asset_id`) REFERENCES `acc_assets`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_assets` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`number` text NOT NULL,
	`name` text NOT NULL,
	`catalog_code` text NOT NULL,
	`account` text NOT NULL,
	`depreciation_account` text NOT NULL,
	`expense_account` text NOT NULL,
	`value_bani` integer NOT NULL,
	`life_months` integer NOT NULL,
	`fiscal_life_months` integer NOT NULL,
	`commissioned_on` text NOT NULL,
	`document_id` text,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`document_id`) REFERENCES `acc_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_number` ON `acc_assets` (`company_id`,`number`);