DROP INDEX `proposal_version_created`;--> statement-breakpoint
ALTER TABLE `acc_proposal_versions` ADD `engine_at` integer;--> statement-breakpoint
CREATE INDEX `proposal_version_engine` ON `acc_proposal_versions` (`company_id`,`engine_at`);--> statement-breakpoint
ALTER TABLE `acc_action_decisions` ADD `engine_at` integer;--> statement-breakpoint
ALTER TABLE `acc_approvals` ADD `engine_at` integer;--> statement-breakpoint
ALTER TABLE `acc_entries` ADD `engine_at` integer;--> statement-breakpoint
ALTER TABLE `acc_evidence` ADD `engine_at` integer;