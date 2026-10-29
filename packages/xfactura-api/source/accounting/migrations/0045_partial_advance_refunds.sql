PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acc_advance_refunds` (
	`company_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `movement_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`payment_id`) REFERENCES `acc_advance_payments`(`company_id`,`payment_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`movement_id`) REFERENCES `acc_movement_postings`(`company_id`,`movement_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_acc_advance_refunds`("company_id", "payment_id", "movement_id", "proposal_id", "journal_id", "created_by", "created_at") SELECT "company_id", "payment_id", "movement_id", "proposal_id", "journal_id", "created_by", "created_at" FROM `acc_advance_refunds`;--> statement-breakpoint
DROP TABLE `acc_advance_refunds`;--> statement-breakpoint
ALTER TABLE `__new_acc_advance_refunds` RENAME TO `acc_advance_refunds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `advance_refund_payment` ON `acc_advance_refunds` (`company_id`,`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `advance_refund_journal` ON `acc_advance_refunds` (`company_id`,`journal_id`);