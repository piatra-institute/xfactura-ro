DROP INDEX `proposal_subject`;--> statement-breakpoint
CREATE INDEX `proposal_subject` ON `acc_proposals` (`company_id`,`subject_key`);