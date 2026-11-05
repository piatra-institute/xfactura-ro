-- Written by hand: accounts 4481 (other debts to the state budget: interest, penalties and fines
-- owed) and 4482 (other claims on it: a payment to the single account not yet distributed, a sum
-- paid in excess) are held on the tax authority's open items, as the chart now controls them for
-- new companies (`controlKindOf`, core ro/chart.ts). Existing companies' accounts gain the same
-- control, the synthetics and their analytics alike, only where nothing was ever posted on them,
-- so no posted line loses its match. The update guard is dropped first; ensureInvariants
-- reinstalls it after the migrations.
DROP TRIGGER IF EXISTS `inv_account_update`;--> statement-breakpoint
UPDATE `acc_accounts` SET `control_kind` = 'tax.payable'
WHERE (`code` = '4481' OR `code` LIKE '4481.%') AND `postable` = 1 AND `control_kind` IS NULL
	AND NOT EXISTS (SELECT 1 FROM `acc_lines` l
		WHERE l.`company_id` = `acc_accounts`.`company_id` AND l.`account` = `acc_accounts`.`code`);--> statement-breakpoint
UPDATE `acc_accounts` SET `control_kind` = 'tax.receivable'
WHERE (`code` = '4482' OR `code` LIKE '4482.%') AND `postable` = 1 AND `control_kind` IS NULL
	AND NOT EXISTS (SELECT 1 FROM `acc_lines` l
		WHERE l.`company_id` = `acc_accounts`.`company_id` AND l.`account` = `acc_accounts`.`code`);
