CREATE TABLE `acc_employees` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`party_id` text NOT NULL,
	`cnp_sealed` text NOT NULL,
	`birth_date` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`party_id`) REFERENCES `acc_parties`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_party` ON `acc_employees` (`company_id`,`party_id`);--> statement-breakpoint
CREATE TABLE `acc_employment_terms` (
	`company_id` text NOT NULL,
	`contract_id` text NOT NULL,
	`seq` integer NOT NULL,
	`employee_id` text NOT NULL,
	`number` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`effective_from` text NOT NULL,
	`base_salary_bani` integer NOT NULL,
	`daily_hours` integer NOT NULL,
	`main_job` integer NOT NULL,
	`occupation` text NOT NULL,
	`dependents` integer NOT NULL,
	`children_in_school` integer NOT NULL,
	`union_dues_bani` integer NOT NULL,
	`minimum_exemption` text,
	`evidence_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `contract_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`employee_id`) REFERENCES `acc_employees`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`evidence_id`) REFERENCES `acc_evidence`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `terms_employee` ON `acc_employment_terms` (`company_id`,`employee_id`);--> statement-breakpoint
CREATE TABLE `acc_payroll_lines` (
	`company_id` text NOT NULL,
	`run_id` text NOT NULL,
	`contract_id` text NOT NULL,
	`terms_seq` integer NOT NULL,
	`employee_id` text NOT NULL,
	`party_id` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text NOT NULL,
	`cash_bani` integer NOT NULL,
	`vouchers_bani` integer NOT NULL,
	`cas_bani` integer NOT NULL,
	`cass_bani` integer NOT NULL,
	`cas_employer_bani` integer NOT NULL,
	`cass_employer_bani` integer NOT NULL,
	`tax_bani` integer NOT NULL,
	`union_dues_bani` integer NOT NULL,
	`net_bani` integer NOT NULL,
	`cam_bani` integer NOT NULL,
	`issues` integer NOT NULL,
	PRIMARY KEY(`company_id`, `run_id`, `contract_id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`run_id`) REFERENCES `acc_payroll_runs`(`company_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`contract_id`,`terms_seq`) REFERENCES `acc_employment_terms`(`company_id`,`contract_id`,`seq`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_payroll_run_events` (
	`company_id` text NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `run_id`, `seq`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`,`run_id`) REFERENCES `acc_payroll_runs`(`company_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acc_payroll_runs` (
	`id` text NOT NULL,
	`company_id` text NOT NULL,
	`month` text NOT NULL,
	`round` integer NOT NULL,
	`working_days` integer NOT NULL,
	`result_hash` text NOT NULL,
	`issues` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`company_id`, `id`),
	FOREIGN KEY (`company_id`) REFERENCES `acc_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payroll_run_month` ON `acc_payroll_runs` (`company_id`,`month`,`round`);