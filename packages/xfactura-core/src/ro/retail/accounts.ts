import type { Issue, WarehouseRecord } from '../../kernel';
import type { RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import { stockAccountsAt } from '../stock/treatments';

/*
 * Where a warehouse kept at its retail price keeps its goods (OMFP nr. 1.802/2014 pct. 286 alin.
 * (8); the functions of 371, 378 and 4428): an analytic of each synthetic `ro.stock.accounts`
 * names, per warehouse, and per VAT rate for the goods and the VAT their sale price includes:
 * - `371.<code>-<rate>`, the goods at their sale price with VAT;
 * - `378.<code>`, the markup (adaosul comercial) they include;
 * - `4428.<code>-<rate>`, the VAT their sale price includes (TVA neexigibilă).
 * The three are of the `retail` control: every line on them carries its warehouse's tag
 * (`retail:<warehouse id>`), which only the retail treatments write, and none carries a tax
 * entry. So the VAT included in stock prices is never mixed with VAT on collection, which stays
 * on the tax-controlled 4428 with its tax entries.
 */

/** A warehouse code an account can carry: capitals, digits and underscores. */
export const retailCodePattern = /^[A-Z0-9_]{1,20}$/;
export const retailTag = (warehouseId: string) => `retail:${warehouseId}`;
export const isRetailTag = (item: string | undefined) => !!item?.startsWith('retail:');

export interface RetailAccounts {
  goods: string;
  markup: string;
  vat: string;
}

/** The synthetic accounts of the retail price method: the goods (371), the markup and the VAT
 * included (`ro.stock.accounts` retail). */
export function retailSynthetics(rules: RuleContext, date: LocalDate) {
  const accounts = stockAccountsAt(rules, date);
  return { goods: '371', markup: accounts.retail.markup, vat: accounts.retail.vat };
}

/** A rate as an account code carries it: whole percents ('21', '11', '0'); null otherwise. */
export const rateSegment = (rate: string) => (/^\d{1,2}$/.test(rate) ? rate : null);

/** The accounts of a warehouse at retail price, for a rate. */
export function retailAccountsOf(
  synthetics: { goods: string; markup: string; vat: string },
  code: string,
  rate: string,
): RetailAccounts {
  return {
    goods: `${synthetics.goods}.${code}-${rate}`,
    markup: `${synthetics.markup}.${code}`,
    vat: `${synthetics.vat}.${code}-${rate}`,
  };
}

/** The rate of a warehouse's goods account (`371.M1-21` → `21`), or null for another account. */
export function retailGoodsRate(goods: string, code: string, account: string): string | null {
  const match = new RegExp(`^${goods}\\.${code}-(\\d{1,2})$`).exec(account);
  return match ? match[1]! : null;
}

/** The warehouse, when its code can name retail accounts. */
export function retailWarehouse(
  warehouses: ReadonlyMap<string, WarehouseRecord>,
  id: string,
  path: string,
): WarehouseRecord | Issue {
  const warehouse = warehouses.get(id);
  if (!warehouse)
    return {
      code: 'STOCK_WAREHOUSE_UNKNOWN',
      severity: 'block',
      message: 'Gestiunea nu există.',
      path,
    };
  if (!retailCodePattern.test(warehouse.code))
    return {
      code: 'RETAIL_WAREHOUSE_CODE',
      severity: 'block',
      message: `Codul gestiunii ${warehouse.code} nu poate denumi conturi analitice (litere mari, cifre, _): conturile la preț cu amănuntul se deschid cu retail.setup pentru o gestiune cu un astfel de cod.`,
      path,
    };
  return warehouse;
}
