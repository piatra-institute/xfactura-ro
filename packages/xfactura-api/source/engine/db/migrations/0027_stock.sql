CREATE TABLE `acc_stock_items` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`nc8` text,
	`account` text NOT NULL,
	`vat_category` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`account`) REFERENCES `acc_accounts`(`company_id`,`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_item_code` ON `acc_stock_items` (`company_id`,`code`);--> statement-breakpoint
CREATE TABLE `acc_stock_layers` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`item_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`account` text NOT NULL,
	`method` text NOT NULL,
	`date` text NOT NULL,
	`may_go_negative` integer NOT NULL,
	`origin_entry_id` text NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`origin_entry_id`) REFERENCES `acc_entries`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`item_id`) REFERENCES `acc_stock_items`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`warehouse_id`) REFERENCES `acc_warehouses`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_layer_origin` ON `acc_stock_layers` (`company_id`,`origin_entry_id`);--> statement-breakpoint
CREATE INDEX `stock_layer_position` ON `acc_stock_layers` (`company_id`,`item_id`,`warehouse_id`);--> statement-breakpoint
CREATE TABLE `acc_stock_moves` (
	`company_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`move_no` integer NOT NULL,
	`item_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`account` text NOT NULL,
	`layer_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`bani` integer NOT NULL,
	`line_no` integer,
	PRIMARY KEY(`company_id`, `entry_id`, `move_no`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`entry_id`) REFERENCES `acc_entries`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`layer_id`) REFERENCES `acc_stock_layers`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_move_amount" CHECK("acc_stock_moves"."quantity" <> 0 or "acc_stock_moves"."bani" <> 0)
);
--> statement-breakpoint
CREATE INDEX `stock_move_position` ON `acc_stock_moves` (`company_id`,`item_id`,`warehouse_id`);--> statement-breakpoint
CREATE INDEX `stock_move_layer` ON `acc_stock_moves` (`company_id`,`layer_id`);--> statement-breakpoint
CREATE INDEX `stock_move_account` ON `acc_stock_moves` (`company_id`,`account`);--> statement-breakpoint
CREATE TABLE `acc_warehouses` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`keeper` text NOT NULL,
	`keeper_party_id` text,
	`evidence_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`keeper_party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_code` ON `acc_warehouses` (`company_id`,`code`);