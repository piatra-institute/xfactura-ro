DROP INDEX `deferral_cancellation_source`;--> statement-breakpoint
ALTER TABLE `acc_deferral_cancellations` ADD `sequence` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `deferral_cancellation_deferral` ON `acc_deferral_cancellations` (`company_id`,`deferral_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deferral_cancellation_sequence` ON `acc_deferral_cancellations` (`company_id`,`deferral_id`,`sequence`);