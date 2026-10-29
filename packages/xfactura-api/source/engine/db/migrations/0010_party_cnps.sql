CREATE TABLE `acc_party_cnps` (
	`company_id` text NOT NULL,
	`party_id` text NOT NULL,
	`cnp_sealed` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `party_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
