import { halfYearDefinitions } from '../../packages/xfactura-core/src/ro/annual/half-year';
import { determinationDefinitions } from '../../packages/xfactura-core/src/ro/determinations/parameters';
import { dividendDefinitions } from '../../packages/xfactura-core/src/ro/dividends';
import { etvaDefinitions } from '../../packages/xfactura-core/src/ro/etva';
import { exemptDefinitions } from '../../packages/xfactura-core/src/ro/exempt/parameters';
import { interestDefinitions } from '../../packages/xfactura-core/src/ro/financing';
import { fxDefinitions } from '../../packages/xfactura-core/src/ro/fx';
import { microDefinitions } from '../../packages/xfactura-core/src/ro/micro';
import { nonpayerDefinitions } from '../../packages/xfactura-core/src/ro/nonpayers/parameters';
import { obligationDefinitions } from '../../packages/xfactura-core/src/ro/obligations';
import { ossDefinitions } from '../../packages/xfactura-core/src/ro/oss/parameters';
import { payrollDefinitions } from '../../packages/xfactura-core/src/ro/payroll/parameters';
import { sickLeaveDefinitions } from '../../packages/xfactura-core/src/ro/payroll/sick-leave';
import { pitDefinitions } from '../../packages/xfactura-core/src/ro/pit/parameters';
import { procedureDefinitions } from '../../packages/xfactura-core/src/ro/procedure';
import { productionDefinitions } from '../../packages/xfactura-core/src/ro/production/parameters';
import { profitDefinitions } from '../../packages/xfactura-core/src/ro/profit/parameters';
import { receiptDefinitions } from '../../packages/xfactura-core/src/ro/receipts/parameters';
import { retailDefinitions } from '../../packages/xfactura-core/src/ro/retail/parameters';
import { saftDefinitions } from '../../packages/xfactura-core/src/ro/saft/parameters';
import { schemeDefinitions } from '../../packages/xfactura-core/src/ro/schemes/parameters';
import { stockDefinitions } from '../../packages/xfactura-core/src/ro/stock/parameters';
import { taxAccountDefinitions } from '../../packages/xfactura-core/src/ro/taxaccount/parameters';
import { tradeDefinitions } from '../../packages/xfactura-core/src/ro/trade/parameters';
import { cashDefinitions } from '../../packages/xfactura-core/src/ro/treatments/cash';
import { vatDefinitions } from '../../packages/xfactura-core/src/ro/vat';
import { withholdingDefinitions } from '../../packages/xfactura-core/src/ro/withholding/parameters';
import { yearEndDefinitions } from '../../packages/xfactura-core/src/ro/yearend/parameters';
import type { ParameterDefinition } from '../../packages/xfactura-core/src/rules';

// A key's prefix need not name its module (for example ro.deadline.*). Reuse the defining
// modules' arrays; the report refuses a register key without a family instead of guessing.
const families: Record<string, readonly ParameterDefinition[]> = {
  annual: halfYearDefinitions,
  determinations: determinationDefinitions,
  dividends: dividendDefinitions,
  etva: etvaDefinitions,
  exempt: exemptDefinitions,
  financing: interestDefinitions,
  fx: fxDefinitions,
  micro: microDefinitions,
  nonpayers: nonpayerDefinitions,
  obligations: obligationDefinitions,
  oss: ossDefinitions,
  payroll: [...payrollDefinitions, ...sickLeaveDefinitions],
  pit: pitDefinitions,
  procedure: procedureDefinitions,
  production: productionDefinitions,
  profit: profitDefinitions,
  receipts: receiptDefinitions,
  retail: retailDefinitions,
  saft: saftDefinitions,
  schemes: schemeDefinitions,
  stock: stockDefinitions,
  taxaccount: taxAccountDefinitions,
  trade: tradeDefinitions,
  cash: cashDefinitions,
  vat: vatDefinitions,
  withholding: withholdingDefinitions,
  yearend: yearEndDefinitions,
};

export const ruleFamilies = new Map(
  Object.entries(families).flatMap(([family, definitions]) =>
    definitions.map(({ key }) => [key, family] as const),
  ),
);
