import type { AnswerRecord, Loaded } from '../kernel';
import { normalizePlate, questionKinds, type VehicleUseAnswer } from '../questions/kinds';
import type { LocalDate } from '../time';

/*
 * Road vehicles and the VAT their costs deduct (Codul fiscal art. 298, norme pct. 68). The
 * deduction of VAT on buying, leasing or renting a motorized road vehicle of at most 3,500 kg and
 * 9 seats, the driver's included, and on the costs directly attributable to it (repairs, upkeep,
 * lubricants, spare parts, fuel), is limited to the register's share (50%) unless the vehicle is
 * used only for the business, shown by its log (foaia de parcurs), or is one the article excepts.
 * Which it is, a person says once per vehicle (`vehicle.use`); the treatments read that answer
 * from the proposal's basis and never guess it.
 */

export const VEHICLE_CLAUSES = [
  'ANAF/Cod-fiscal-consolidat:art.298',
  'ANAF/Cod-fiscal-consolidat:norme.art.298.pct.68',
];

/** Accounts whose costs are a vehicle's by their nature: fuel (6022) and the vehicles
 * themselves (2133). */
const vehicleAccounts = /^(6022|2133)$/;
/** Accounts that hold a vehicle's costs among others, when the lines say a vehicle: repairs and
 * upkeep (611), rents and operating leases (612), spare parts (6024) and a finance lease's
 * principal (167). */
const sometimesVehicle = /^(611|612|6024|167)$/;
const vehicleWords =
  /\b(auto|autoturism\w*|autovehicul\w*|autoutilitar\w*|vehicul\w*|masin\w*|carburant\w*|combustibil\w*|motorin\w*|benzin\w*|anvelop\w*|itp|rovinieta)\b/;
/** Lower case, without diacritics. */
const folded = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** A Romanian registration as invoices print it: `B 123 ABC`, `CJ-12-ABC`. */
const plateLike = /\b[A-Z]{1,2}[ -]?\d{2,3}[ -]?[A-Z]{3}\b/;

/**
 * Whether a purchase on this account, with these lines, looks like a vehicle's cost: the account
 * alone for fuel and vehicles, the account and a word or a registration in the lines for the
 * accounts that hold other costs too.
 */
export function suggestsVehicle(account: string, lines: readonly string[]): boolean {
  const synthetic = account.split('.')[0]!;
  if (vehicleAccounts.test(synthetic)) return true;
  if (!sometimesVehicle.test(synthetic)) return false;
  return lines.some((line) => vehicleWords.test(folded(line)) || plateLike.test(line));
}

/** A registration in its one spelling, as the `vehicle.use` question names it. */
export const vehicleSubject = (plate: string) => ({ kind: 'vehicle', id: normalizePlate(plate) });

/** What a vehicle's VAT deducts, by the person's answer: in full when it is used only for the
 * business (with its log) or the article does not limit it, else the limited share. */
export function vehicleDeduction(answer: VehicleUseAnswer): 'full' | 'limited' {
  return answer.exception !== undefined || answer.use === 'business_only' ? 'full' : 'limited';
}

/** The answer about a vehicle the basis cites, read by its kind's schema, with the record that
 * holds it; the latest when the basis cites more than one. */
export function vehicleAnswer(
  loaded: Loaded,
  plate: string,
): { record: AnswerRecord; value: VehicleUseAnswer } | null {
  const kind = questionKinds['vehicle.use'];
  let found: { record: AnswerRecord; value: VehicleUseAnswer } | null = null;
  for (const record of loaded.answers.values()) {
    if (
      record.kind !== kind.id ||
      record.subject.kind !== 'vehicle' ||
      normalizePlate(record.subject.id) !== plate
    )
      continue;
    const parsed = kind.answer({}).safeParse(record.value);
    if (!parsed.success) continue;
    // The latest by the engine's time of the answer; the answer's id breaks a tie, so the
    // order the basis lists its questions in never decides.
    if (
      !found ||
      found.record.answeredAt < record.answeredAt ||
      (found.record.answeredAt === record.answeredAt && found.record.answerId < record.answerId)
    )
      found = { record, value: parsed.data };
  }
  return found;
}

/** Whether an answer speaks for a date: the use it states holds from its `from`. */
export const answerCovers = (answer: VehicleUseAnswer, date: LocalDate) => answer.from <= date;
