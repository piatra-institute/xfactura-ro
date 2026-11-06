import type { ReviewSpec } from '../types';
import { halfYearSpec, statementsDeadlineSpec } from './annual';
import {
  microLinkedSpec,
  payrollQuarterlySpec,
  sizeThresholdsSpec,
  vatExemptionSpec,
} from './determinations';
import { microLimitSpec, microRateSpec } from './micro';
import {
  capitalGoodsSpec,
  lateRegistrationSpec,
  registrationAnnualizedSpec,
  specialPayableSpec,
} from './nonpayers';
import { capitalMinimumSpec, prorataSpec, stockAdjustmentSpec } from './exempt';
import { d112QuarterlySpec, pitNormaSpec, pitSourcesSpec } from './pf';
import {
  garnishmentLimitsSpec,
  mandateDeductionSpec,
  retroactiveCorrectionSpec,
  regesChangeSpec,
  sickAccidentSpec,
  sickCodesSpec,
  voucherLimitsSpec,
} from './payroll';
import { legalReserveSpec, lossCarryforwardSpec, socialLimitSpec, sponsorshipSpec } from './profit';
import {
  d406AssetsDeadlineSpec,
  d406ConversionSpec,
  d406PresentationSpec,
  d406StartSpec,
} from './saft';
import { reverseChargeSpec, simplifiedInvoiceSpec } from './receipts';
import { flatRateSpec, goodsMarginSpec, travelMarginSpec } from './schemes';
import {
  d406OssSpec,
  distanceThresholdSpec,
  ossDeclarationsSpec,
  ossPayableSpec,
  ossReturnSpec,
} from './oss';
import { accountsSpec, advanceSpec, distributionSpec } from './taxaccount';
import { vatDeductionLimitedSpec, vatRateSpec, vatReducedRateSpec } from './vat';
import { impairmentAccountsSpec, inventoryAccountsSpec, provisionAccountsSpec } from './yearend';
import { stockAccountsSpec, stockMethodsSpec, stockReturnsSpec } from './stock';
import { importSpec, transportSpec, viesSpec } from './trade';
import { efacturaB2cSpec, retailCoefficientSpec, retailZReportSpec } from './retail';
import {
  productionAccountsSpec,
  productionCoefficientSpec,
  productionCostingSpec,
} from './production';
import {
  certificateDaysSpec,
  dividendRateSpec,
  ipRateSpec,
  nonresidentRateSpec,
  rentRateSpec,
} from './withholding';
import { adjustmentBooksSpec, adjustmentVatSpec } from './credit';

/** Every parameter a packet can be generated for. A key without a spec cannot be reviewed. */
export const reviewSpecs: readonly ReviewSpec[] = [
  vatRateSpec,
  vatReducedRateSpec,
  vatDeductionLimitedSpec,
  microRateSpec,
  microLimitSpec,
  microLinkedSpec,
  payrollQuarterlySpec,
  sizeThresholdsSpec,
  vatExemptionSpec,
  d112QuarterlySpec,
  pitSourcesSpec,
  pitNormaSpec,
  statementsDeadlineSpec,
  halfYearSpec,
  legalReserveSpec,
  socialLimitSpec,
  sponsorshipSpec,
  lossCarryforwardSpec,
  distributionSpec,
  advanceSpec,
  accountsSpec,
  d406AssetsDeadlineSpec,
  d406StartSpec,
  d406PresentationSpec,
  d406ConversionSpec,
  specialPayableSpec,
  lateRegistrationSpec,
  registrationAnnualizedSpec,
  capitalGoodsSpec,
  prorataSpec,
  stockAdjustmentSpec,
  capitalMinimumSpec,
  simplifiedInvoiceSpec,
  reverseChargeSpec,
  travelMarginSpec,
  goodsMarginSpec,
  flatRateSpec,
  rentRateSpec,
  ipRateSpec,
  nonresidentRateSpec,
  certificateDaysSpec,
  dividendRateSpec,
  inventoryAccountsSpec,
  impairmentAccountsSpec,
  provisionAccountsSpec,
  mandateDeductionSpec,
  garnishmentLimitsSpec,
  retroactiveCorrectionSpec,
  sickCodesSpec,
  sickAccidentSpec,
  voucherLimitsSpec,
  regesChangeSpec,
  distanceThresholdSpec,
  ossDeclarationsSpec,
  d406OssSpec,
  ossPayableSpec,
  ossReturnSpec,
  stockAccountsSpec,
  stockMethodsSpec,
  stockReturnsSpec,
  viesSpec,
  transportSpec,
  importSpec,
  retailCoefficientSpec,
  retailZReportSpec,
  efacturaB2cSpec,
  productionAccountsSpec,
  productionCostingSpec,
  productionCoefficientSpec,
  adjustmentVatSpec,
  adjustmentBooksSpec,
];
