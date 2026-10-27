CREATE TABLE `acc_correction_outcomes` (
	`company_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`purchase_proposal_id` text NOT NULL,
	`target_journal_id` text NOT NULL,
	`status` text NOT NULL,
	`journal_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `proposal_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`purchase_proposal_id`) REFERENCES `acc_proposals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`target_journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`journal_id`) REFERENCES `acc_journals`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "correction_outcome" CHECK(("acc_correction_outcomes"."status"='posted' and "acc_correction_outcomes"."journal_id" is not null) or ("acc_correction_outcomes"."status"='withdrawn' and "acc_correction_outcomes"."journal_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correction_target` ON `acc_correction_outcomes` (`company_id`,`target_journal_id`) WHERE "acc_correction_outcomes"."status"='posted';--> statement-breakpoint
CREATE UNIQUE INDEX `correction_journal` ON `acc_correction_outcomes` (`company_id`,`journal_id`);