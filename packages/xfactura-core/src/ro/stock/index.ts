import { stockCount, stockIntermittent } from './inventory';
import { stockTreatments as registerTreatments } from './treatments';

export * from './parameters';
export * from './valuation';
export {
  consumeInput,
  itemOf,
  openingInput,
  periodCostInput,
  periodCostOf,
  productAccounts,
  quantityInput,
  receiveInput,
  stockAccountsAt,
  stockConsumption,
  stockImpairment,
  stockImpairmentInput,
  stockImpairmentTag,
  stockOpening,
  stockPeriodCost,
  stockPolicyAxes,
  stockReceipt,
  stockTransfer,
  transferInput,
  warehouseOf,
} from './treatments';
export * from './invoices';
export * from './count';
export * from './inventory';

/** Every treatment of the stock register, as the engine adds them. */
export const stockTreatments = [...registerTreatments, stockCount, stockIntermittent] as const;
