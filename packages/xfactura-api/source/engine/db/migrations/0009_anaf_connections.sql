CREATE TABLE `acc_anaf_connections` (
	`company_id` text NOT NULL,
	`seq` integer NOT NULL,
	`environment` text NOT NULL,
	`access_sealed` text NOT NULL,
	`refresh_sealed` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
