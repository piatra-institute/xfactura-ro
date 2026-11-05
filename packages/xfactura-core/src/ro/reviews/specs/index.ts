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
import { d112QuarterlySpec, pitNormaSpec, pitSourcesSpec } from './pf';
import { legalReserveSpec, lossCarryforwardSpec, socialLimitSpec, sponsorshipSpec } from './profit';
import { d406AssetsDeadlineSpec, d406PresentationSpec, d406StartSpec } from './saft';
import { accountsSpec, advanceSpec, distributionSpec } from './taxaccount';
import { vatDeductionLimitedSpec, vatRateSpec, vatReducedRateSpec } from './vat';

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
  specialPayableSpec,
  lateRegistrationSpec,
  registrationAnnualizedSpec,
  capitalGoodsSpec,
];
