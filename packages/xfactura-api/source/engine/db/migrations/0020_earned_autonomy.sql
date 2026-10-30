CREATE TABLE `acc_automation_criteria` (
	`company_id` text NOT NULL,
	`seq` integer NOT NULL,
	`min_correct` integer NOT NULL,
	`min_months` integer NOT NULL,
	`policy_days` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`epoch` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "automation_criteria_floor" CHECK("acc_automation_criteria"."min_correct" between 6 and 1000 and "acc_automation_criteria"."min_months" between 3 and 120 and "acc_automation_criteria"."policy_days" between 1 and 90)
);
--> statement-breakpoint
CREATE TABLE `acc_automation_events` (
	`company_id` text NOT NULL,
	`seq` integer NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`trigger` text,
	`details_json` text,
	`created_by` text NOT NULL,
	`agent_id` text,
	`epoch` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "automation_event" CHECK("acc_automation_events"."scope" in ('company', 'policy', 'template') and "acc_automation_events"."kind" in ('pause', 'resume') and ("acc_automation_events"."scope" = 'company') = ("acc_automation_events"."scope_id" is null))
);
--> statement-breakpoint
CREATE INDEX `automation_scope` ON `acc_automation_events` (`company_id`,`scope`,`scope_id`,`seq`);--> statement-breakpoint
ALTER TABLE `acc_posting_policies` ADD `request_id` text;--> statement-breakpoint
-- Written by hand: the reserved system principal (`SYSTEM_PRINCIPAL` in kernel/automation.ts),
-- in whose name the worker sweeps, pauses and demotes. It has no password or session, and the
-- invariants keep it out of every company's members (`inv:system_member`), so it never approves,
-- decides or creates a policy.
INSERT OR IGNORE INTO `user` (`id`, `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at`)
VALUES ('system', 'xFactura (sistem)', 'system@xfactura.invalid', 0, NULL, 0, 0);
