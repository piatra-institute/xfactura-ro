import { addDays, type LocalDate } from '../../time';
import type { ETransportRule } from './parameters';

/*
 * RO e-Transport (OUG nr. 41/2022), tracked, never integrated: a road transport of goods of high
 * fiscal risk (the goods an ANAF order lists, art. 15 alin. (2)) is declared in the system by the
 * party art. 8 alin. (1) names, which gives the carrier the UIT code before the transport starts.
 * The engine lists each transport its books hold (an intra-community acquisition or supply, an
 * import, an export), who declares it and by when, and the UIT code a person records; whether the
 * goods are of high fiscal risk is the person's answer (`etransport.uit`), never presumed.
 */

export const etransportFlows = ['acquisition', 'supply', 'import', 'export'] as const;
export type ETransportFlow = (typeof etransportFlows)[number];

/** Who declares a transport (art. 8 alin. (1)). */
export const etransportDeclarant: Record<ETransportFlow, string> = {
  acquisition: 'beneficiarul din România al achiziției intracomunitare (art. 8 alin. (1) lit. b))',
  supply: 'furnizorul din România al livrării intracomunitare (art. 8 alin. (1) lit. c))',
  import: 'destinatarul înscris în declarația vamală de import (art. 8 alin. (1) lit. a))',
  export: 'expeditorul înscris în declarația vamală de export (art. 8 alin. (1) lit. a))',
};

export interface ETransportObligation {
  flow: ETransportFlow;
  declarant: string;
  /** The transport's expected start: the supply's or the declaration's date. */
  start: LocalDate;
  /** The data are declared from `declareFrom` until the transport starts (art. 11 alin. (1)). */
  declareFrom: LocalDate;
  declareBy: LocalDate;
  /** The UIT code's last valid day (alin. (2)). */
  validUntil: LocalDate;
}

/** The window art. 11 gives a transport starting on `start`. */
export function etransportObligation(
  flow: ETransportFlow,
  start: LocalDate,
  rule: ETransportRule,
): ETransportObligation {
  return {
    flow,
    declarant: etransportDeclarant[flow],
    start,
    declareFrom: addDays(start, -rule.declareDaysBefore),
    declareBy: start,
    validUntil: addDays(start, rule.validityDays - 1),
  };
}
