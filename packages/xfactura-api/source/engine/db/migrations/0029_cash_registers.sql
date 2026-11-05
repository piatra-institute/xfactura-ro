CREATE TABLE `acc_cash_register_events` (
	`company_id` text NOT NULL,
	`register_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`reference` text,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `register_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`register_id`) REFERENCES `acc_cash_registers`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_cash_registers` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`fiscal_series` text NOT NULL,
	`location` text NOT NULL,
	`warehouse_id` text,
	`active_from` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`warehouse_id`) REFERENCES `acc_warehouses`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_register_code` ON `acc_cash_registers` (`company_id`,`code`);