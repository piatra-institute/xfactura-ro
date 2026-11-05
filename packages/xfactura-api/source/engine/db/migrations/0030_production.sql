CREATE TABLE `acc_bom_lines` (
	`company_id` text NOT NULL,
	`bom_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	PRIMARY KEY(`company_id`, `bom_id`, `line_no`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`bom_id`) REFERENCES `acc_boms`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`item_id`) REFERENCES `acc_stock_items`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_boms` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`item_id` text NOT NULL,
	`version` integer NOT NULL,
	`valid_from` text NOT NULL,
	`output_quantity` integer NOT NULL,
	`standard_cost` integer,
	`labour_hours` integer,
	`machine_hours` integer,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`item_id`) REFERENCES `acc_stock_items`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bom_version` ON `acc_boms` (`company_id`,`item_id`,`version`);--> statement-breakpoint
CREATE TABLE `acc_work_order_events` (
	`company_id` text NOT NULL,
	`order_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `order_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`order_id`) REFERENCES `acc_work_orders`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_work_orders` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`number` text NOT NULL,
	`item_id` text NOT NULL,
	`bom_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`opened_on` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`item_id`) REFERENCES `acc_stock_items`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`bom_id`) REFERENCES `acc_boms`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_order_number` ON `acc_work_orders` (`company_id`,`number`);