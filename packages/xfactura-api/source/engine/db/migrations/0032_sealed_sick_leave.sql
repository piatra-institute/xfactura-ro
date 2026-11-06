-- The accounts payments of pay went to, which the money registers withhold from a reader who may
-- not read pay (kernel/salaries.ts). The data step of this migration (db/identity.ts,
-- sealSickLeave) then seals what the books kept in clear of a month's sick leave: each medical
-- certificate a payroll line paid, its issues and the labels of its pay items, and each absence of
-- an answer about a month's absences, under the installation's secret.
CREATE INDEX `bank_movement_counterparty` ON `acc_bank_movements` (`company_id`,`counterparty_account`);
