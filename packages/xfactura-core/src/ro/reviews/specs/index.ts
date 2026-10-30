import type { ReviewSpec } from '../types';
import {
  microLinkedSpec,
  payrollQuarterlySpec,
  sizeThresholdsSpec,
  vatExemptionSpec,
} from './determinations';
import { microLimitSpec, microRateSpec } from './micro';
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
];
