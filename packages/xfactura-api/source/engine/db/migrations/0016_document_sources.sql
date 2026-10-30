CREATE TABLE `acc_bank_mappings` (
	`company_id` text NOT NULL,
	`treasury_account_id` text NOT NULL,
	`version` integer NOT NULL,
	`format` text NOT NULL,
	`mapping_json` text NOT NULL,
	`mapping_hash` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `treasury_account_id`, `version`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`treasury_account_id`) REFERENCES `acc_treasury_accounts`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `acc_bank_statements` ADD `citations_json` text;--> statement-breakpoint
ALTER TABLE `acc_documents` ADD `identity_key` text;--> statement-breakpoint
ALTER TABLE `acc_documents` ADD `authority` text;--> statement-breakpoint
ALTER TABLE `acc_documents` ADD `checks_json` text;--> statement-breakpoint
ALTER TABLE `acc_documents` ADD `citations_json` text;--> statement-breakpoint
CREATE INDEX `document_identity` ON `acc_documents` (`company_id`,`identity_key`);--> statement-breakpoint
CREATE INDEX `document_link_target` ON `acc_document_links` (`company_id`,`to_id`);--> statement-breakpoint
-- Written by hand: existing documents gain their authority, and their identity where it can be
-- derived without hashing. The update guard is dropped first; ensureInvariants reinstalls it
-- after the migrations. An e-Factura document's identity is the hash its `invoice:` source key
-- already holds when its number is in normal form (printable ASCII, no spaces, capitals); issued
-- and invoicer documents, and numbers needing normalization, keep no identity and join no group.
DROP TRIGGER IF EXISTS `inv_acc_documents_no_update`;--> statement-breakpoint
UPDATE `acc_documents` SET `authority` = CASE `origin`
	WHEN 'spv' THEN 'efactura'
	WHEN 'upload' THEN 'ubl_upload'
	WHEN 'issued' THEN 'issued'
	WHEN 'invoicer-export' THEN 'invoicer'
END;--> statement-breakpoint
UPDATE `acc_documents` SET `identity_key` = substr(`source_key`, 9)
WHERE `source_key` LIKE 'invoice:%' AND `number` = upper(`number`) AND `number` NOT GLOB '*[^!-~]*';
