DROP INDEX `stock_move_position`;--> statement-breakpoint
DROP INDEX `stock_move_layer`;--> statement-breakpoint
CREATE INDEX `stock_move_position` ON `acc_stock_moves` (`company_id`,`item_id`,`warehouse_id`,`entry_id`);--> statement-breakpoint
CREATE INDEX `stock_move_layer` ON `acc_stock_moves` (`company_id`,`layer_id`,`quantity`,`bani`);--> statement-breakpoint
CREATE INDEX `line_tax_settlement` ON `acc_lines` (`company_id`,`tax_settlement_tax`,`tax_settlement_period`) WHERE tax_settlement_tax is not null;