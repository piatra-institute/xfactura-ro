CREATE TABLE `acc_invoice_archive_entries` (
	`company_id` text NOT NULL,
	`id` text NOT NULL,
	`archive_evidence_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`invoice_id` text,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`archive_evidence_id`) REFERENCES `acc_invoice_archives`(`company_id`,`evidence_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`invoice_id`) REFERENCES `acc_invoice_documents`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "archive_entry_kind" CHECK("acc_invoice_archive_entries"."kind" in ('invoice','signature','supporting_xml','attachment') and (("acc_invoice_archive_entries"."kind"='invoice' and "acc_invoice_archive_entries"."invoice_id" is not null) or ("acc_invoice_archive_entries"."kind"<>'invoice' and "acc_invoice_archive_entries"."invoice_id" is null)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_entry_path` ON `acc_invoice_archive_entries` (`company_id`,`archive_evidence_id`,`path`);--> statement-breakpoint
CREATE INDEX `archive_entry_invoice` ON `acc_invoice_archive_entries` (`company_id`,`invoice_id`,`id`);--> statement-breakpoint
CREATE TABLE `acc_invoice_archives` (
	`company_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`format_version` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`file_count` integer NOT NULL,
	`invoice_count` integer NOT NULL,
	`expanded_bytes` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `evidence_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "archive_format" CHECK("acc_invoice_archives"."format_version"='efactura-zip-1'),
	CONSTRAINT "archive_manifest" CHECK(json_valid("acc_invoice_archives"."manifest") and json_type("acc_invoice_archives"."manifest")='array' and json_array_length("acc_invoice_archives"."manifest")="acc_invoice_archives"."file_count"),
	CONSTRAINT "archive_counts" CHECK(typeof("acc_invoice_archives"."file_count")='integer' and "acc_invoice_archives"."file_count" between 1 and 100 and typeof("acc_invoice_archives"."invoice_count")='integer' and "acc_invoice_archives"."invoice_count" between 0 and "acc_invoice_archives"."file_count" and typeof("acc_invoice_archives"."expanded_bytes")='integer' and "acc_invoice_archives"."expanded_bytes" between 1 and 41943040),
	CONSTRAINT "archive_manifest_hash" CHECK(length("acc_invoice_archives"."manifest_hash")=64 and "acc_invoice_archives"."manifest_hash" not glob '*[^0-9a-f]*')
);
