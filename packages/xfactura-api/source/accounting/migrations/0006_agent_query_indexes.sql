CREATE INDEX `agent_company` ON `acc_agent_grants` (`company_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_company` ON `acc_audit` (`company_id`,`id`);