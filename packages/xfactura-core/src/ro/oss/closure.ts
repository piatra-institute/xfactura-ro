import { confirmQuestion, recordedAt, type Determination } from '../determinations/determine';
import type { ClosureInput, ClosureRule, Slot } from '../determinations/closure';

/*
 * The obligation closure's rules for sales to consumers in other Member States (core ro/oss):
 * per year, the determinations `vat.distance`, `vat.oss` and `vat.ioss` (an unknown fact is a
 * need, an uncovered case UNSUPPORTED, a recorded place the computation contradicts a conflict);
 * per quarter, the Union scheme's return (D398) while the company is registered on some day of
 * the quarter, with or without sales (art. 315 alin. (6)); the import scheme's monthly return is
 * listed UNSUPPORTED.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);

/** The computed value at a day of a proposed determination. */
const computedAt = (determination: Determination, day: string) =>
  determination.changes.filter((change) => change.effectiveFrom <= day).at(-1)?.value ??
  (day >= determination.effectiveFrom ? determination.value : null);

export function ossClosureRules(input: ClosureInput, months: readonly string[]): ClosureRule[] {
  const rules: ClosureRule[] = [];
  const years = [...new Set(months.map((month) => Number(month.slice(0, 4))))];
  for (const year of years) {
    const of = (axis: string) =>
      input.determinations.find((item) => item.axis === axis && item.year === year);
    rules.push({
      id: `scope.oss@${year}`,
      clauses: [`${CODE}:art.278^1(1)-(2)`, `${CODE}:art.315(1)-(2^1)`, `${CODE}:art.315^2(1)-(3)`],
      reads: [],
      derives: [`oss@${year}`],
      run(_read, emit) {
        const blockers: { needs: string[]; triggers: string[] } = { needs: [], triggers: [] };
        for (const axis of ['vat.distance', 'vat.oss', 'vat.ioss']) {
          const determination = of(axis);
          if (!determination) continue;
          if (determination.status === 'unsupported' && determination.unsupported)
            blockers.triggers.push(
              emit.unsupported({
                trigger: determination.unsupported.trigger,
                message: determination.unsupported.message,
                missingCapabilities: determination.unsupported.capabilities,
                evidenceIds: [],
                resolution:
                  'Procesați operațiunile în afara aplicației, atribuit explicit, sau așteptați acoperirea revizuită a regimului.',
              }),
            );
          else if (determination.status === 'needs_evidence')
            for (const question of determination.questions)
              blockers.needs.push(
                emit.need({
                  code: 'DETERMINATION_MISSING',
                  fact: `${axis}/${year}`,
                  message: determination.summary,
                  question,
                }),
              );
          else if (
            determination.status === 'proposed' &&
            input.confirmed[`${axis}/${year}`] !== determination.fingerprint
          ) {
            // A recorded fact the computation contradicts, on any day it changes or at the end.
            const days = [
              determination.effectiveFrom,
              ...determination.changes.map((change) => change.effectiveFrom),
              `${year}-12-31`,
            ];
            const differs = days.some((day) => {
              const recorded = recordedAt(input.facts, axis, day);
              return recorded !== null && recorded !== computedAt(determination, day);
            });
            const missing = days.some((day) => recordedAt(input.facts, axis, day) === null);
            if (differs || (axis === 'vat.distance' && missing))
              blockers.needs.push(
                emit.need({
                  code: differs ? 'DETERMINATION_CONFLICT' : 'DETERMINATION_MISSING',
                  fact: `${axis}/${year}`,
                  message: `${axis} ${differs ? 'înregistrat diferă de calcul' : 'nu este înregistrat'} pentru ${year}: ${determination.summary}`,
                  question: confirmQuestion(determination),
                }),
              );
          }
        }
        const oss = of('vat.oss');
        const slot: Slot = blockers.triggers.length
          ? { state: 'unsupported', triggers: blockers.triggers }
          : blockers.needs.length
            ? { state: 'unknown', needs: blockers.needs }
            : {
                state: 'known',
                value: oss?.status === 'proposed' ? (oss.value ?? 'none') : 'none',
                basis: oss?.status === 'proposed' ? 'determinarea vat.oss' : 'fără regim special',
              };
        emit.derive(`oss@${year}`, slot);
      },
    });
  }
  for (const month of months) {
    const year = Number(month.slice(0, 4));
    if (Number(month.slice(5, 7)) % 3 !== 0) continue;
    const quarter = `${year}-Q${Number(month.slice(5, 7)) / 3}`;
    const start = `${year}-${pad(Number(month.slice(5, 7)) - 2)}-01`;
    const end = lastDay(month);
    rules.push({
      id: `obligation.d398@${quarter}`,
      clauses: [`${CODE}:art.315(6)-(6^1)`, 'ANAF/D398:structura'],
      reads: [`oss@${year}`],
      derives: [],
      run(read, emit) {
        const slot = read(`oss@${year}`);
        const registered =
          recordedAt(input.facts, 'vat.oss', start) === 'union' ||
          input.facts.some(
            (fact) =>
              fact.axis === 'vat.oss' &&
              fact.value === 'union' &&
              fact.effectiveFrom >= start &&
              fact.effectiveFrom <= end,
          );
        if (slot.state === 'unknown')
          emit.obligation({
            kind: 'D398',
            deadline: 'D398',
            period: quarter,
            deadlinePeriod: null,
            state: 'needs_evidence',
            blockers: slot.needs,
          });
        else if (registered)
          emit.obligation({
            kind: 'D398',
            deadline: 'D398',
            period: quarter,
            deadlinePeriod: null,
            state: slot.state === 'unsupported' ? 'unsupported' : 'applies',
            blockers: slot.state === 'unsupported' ? slot.triggers : [],
          });
      },
    });
  }
  // The import scheme's monthly return, which the engine does not prepare.
  for (const month of months) {
    const year = Number(month.slice(0, 4));
    const ioss = input.determinations.find(
      (item) => item.axis === 'vat.ioss' && item.year === year,
    );
    if (ioss?.status !== 'unsupported') continue;
    rules.push({
      id: `obligation.d398.import@${month}`,
      clauses: [`${CODE}:art.315^2(18)-(23)`],
      reads: [`oss@${year}`],
      derives: [],
      run(_read, emit) {
        emit.obligation({
          kind: 'D398.import',
          deadline: null,
          period: month,
          deadlinePeriod: null,
          state: 'unsupported',
          blockers: [ioss.unsupported?.trigger ?? 'IOSS_SCHEME'],
        });
      },
    });
  }
  return rules;
}
