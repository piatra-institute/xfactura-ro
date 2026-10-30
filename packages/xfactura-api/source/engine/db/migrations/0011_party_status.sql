CREATE TABLE `acc_party_status` (
	`company_id` text NOT NULL,
	`party_id` text NOT NULL,
	`seq` integer NOT NULL,
	`cui` text NOT NULL,
	`as_of` text NOT NULL,
	`name` text NOT NULL,
	`vat_payer` integer NOT NULL,
	`cash_vat` integer NOT NULL,
	`inactive` integer NOT NULL,
	`inactive_since` text,
	`reactivated_on` text,
	`split_vat` integer NOT NULL,
	`e_invoice` integer NOT NULL,
	`struck_off_on` text,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `party_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "party_status_cui" CHECK("acc_party_status"."cui" glob '[0-9]*' and length("acc_party_status"."cui") between 2 and 10)
);
--> statement-breakpoint
CREATE INDEX `party_status_date` ON `acc_party_status` (`company_id`,`party_id`,`as_of`);