import { ParameterRegister, type ParameterDefinition, type ParameterVersion } from '../rules';
import { halfYearDefinitions, halfYearVersions } from './annual/half-year';
import { dividendDefinitions, dividendVersions } from './dividends';
import { etvaDefinitions, etvaVersions } from './etva';
import { interestDefinitions, interestVersions } from './financing';
import { fxDefinitions, fxVersions } from './fx';
import { microDefinitions, microVersions } from './micro';
import { nonpayerDefinitions, nonpayerVersions } from './nonpayers/parameters';
import { exemptDefinitions, exemptVersions } from './exempt/parameters';
import { ossDefinitions, ossVersions } from './oss/parameters';
import { obligationDefinitions, obligationVersions } from './obligations';
import { payrollDefinitions, payrollVersions } from './payroll/parameters';
import { sickLeaveDefinitions, sickLeaveVersions } from './payroll/sick-leave';
import { pitDefinitions, pitVersions } from './pit/parameters';
import { receiptDefinitions, receiptVersions } from './receipts/parameters';
import { schemeDefinitions, schemeVersions } from './schemes/parameters';
import { procedureDefinitions, procedureVersions } from './procedure';
import { cashDefinitions, cashVersions } from './treatments/cash';
import { determinationDefinitions, determinationVersions } from './determinations/parameters';
import { profitDefinitions, profitDeadlineVersions, profitVersions } from './profit/parameters';
import { saftDefinitions, saftVersions } from './saft/parameters';
import { taxAccountDefinitions, taxAccountVersions } from './taxaccount/parameters';
import { vatDefinitions, vatVersions } from './vat';
import { withholdingDefinitions, withholdingVersions } from './withholding/parameters';
import { yearEndDefinitions, yearEndVersions } from './yearend/parameters';
import { stockDefinitions, stockVersions } from './stock/parameters';
import { tradeDefinitions, tradeVersions } from './trade/parameters';
import { retailDefinitions, retailVersions } from './retail/parameters';

/**
 * Every Romanian parameter family, in the order the engine's `defaultRegister()` assembles them
 * (`xfactura-api/source/engine/engine.ts`; `scripts/review/review.test.ts` checks the two agree).
 * The review packets and the binding check run over this register.
 */
export const roDefinitions: readonly ParameterDefinition[] = [
  ...vatDefinitions,
  ...fxDefinitions,
  ...procedureDefinitions,
  ...obligationDefinitions,
  ...cashDefinitions,
  ...payrollDefinitions,
  ...sickLeaveDefinitions,
  ...microDefinitions,
  ...dividendDefinitions,
  ...interestDefinitions,
  ...withholdingDefinitions,
  ...etvaDefinitions,
  ...pitDefinitions,
  ...determinationDefinitions,
  ...profitDefinitions,
  ...halfYearDefinitions,
  ...saftDefinitions,
  ...taxAccountDefinitions,
  ...nonpayerDefinitions,
  ...exemptDefinitions,
  ...receiptDefinitions,
  ...schemeDefinitions,
  ...yearEndDefinitions,
  ...ossDefinitions,
  ...stockDefinitions,
  ...tradeDefinitions,
  ...retailDefinitions,
];

export const roVersions: readonly ParameterVersion[] = [
  ...vatVersions,
  ...fxVersions,
  ...procedureVersions,
  ...obligationVersions,
  ...cashVersions,
  ...payrollVersions,
  ...sickLeaveVersions,
  ...microVersions,
  ...dividendVersions,
  ...interestVersions,
  ...withholdingVersions,
  ...etvaVersions,
  ...pitVersions,
  ...determinationVersions,
  ...profitVersions,
  ...profitDeadlineVersions,
  ...halfYearVersions,
  ...saftVersions,
  ...taxAccountVersions,
  ...nonpayerVersions,
  ...exemptVersions,
  ...receiptVersions,
  ...schemeVersions,
  ...yearEndVersions,
  ...ossVersions,
  ...stockVersions,
  ...tradeVersions,
  ...retailVersions,
];

export const roRegister = () => new ParameterRegister(roDefinitions, roVersions);
