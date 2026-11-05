-- Written by hand: account 463 (receivables representing dividends distributed during the
-- financial year, OMFP nr. 3.067/2018 pct. 423^1-423^2) joins the charts seeded before it, and
-- 456 and 463 are held per associate, as the chart now seeds them for new companies
-- (`chartAmendments`, `controlKindOf`, core ro/chart.ts). 463 is added to every chart seeded from
-- the reference chart (one holding group 46) that lacks it. The controls are set, on the
-- synthetics and their analytics alike, only where nothing was ever posted on the account, so no
-- posted line loses its match. The update guard is dropped first; ensureInvariants reinstalls it
-- after the migrations.
DROP TRIGGER IF EXISTS `inv_account_update`;--> statement-breakpoint
INSERT INTO `acc_accounts` (`company_id`, `code`, `parent_code`, `name`, `nature`, `book`, `postable`,
	`control_kind`, `valid_from`, `chart_version`, `created_by`)
SELECT g.`company_id`, '463', '46',
	'Creanțe reprezentând dividende repartizate în cursul exercițiului financiar', 'debit', 'general', 1,
	'receivable', '2018-09-17', 'OMFP3067/2018:pct.423^1-423^2', g.`created_by`
FROM `acc_accounts` g
WHERE g.`code` = '46'
	AND NOT EXISTS (SELECT 1 FROM `acc_accounts` a
		WHERE a.`company_id` = g.`company_id` AND a.`code` = '463');--> statement-breakpoint
UPDATE `acc_accounts` SET `control_kind` = 'payable'
WHERE (`code` = '456' OR `code` LIKE '456.%') AND `postable` = 1 AND `control_kind` IS NULL
	AND NOT EXISTS (SELECT 1 FROM `acc_lines` l
		WHERE l.`company_id` = `acc_accounts`.`company_id` AND l.`account` = `acc_accounts`.`code`);--> statement-breakpoint
UPDATE `acc_accounts` SET `control_kind` = 'receivable'
WHERE (`code` = '463' OR `code` LIKE '463.%') AND `postable` = 1 AND `control_kind` IS NULL
	AND NOT EXISTS (SELECT 1 FROM `acc_lines` l
		WHERE l.`company_id` = `acc_accounts`.`company_id` AND l.`account` = `acc_accounts`.`code`);
