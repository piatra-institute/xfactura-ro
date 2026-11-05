import { confirmQuestion, recordedAt } from '../determinations/determine';
import type { ClosureInput, ClosureRule } from '../determinations/closure';
import { intrastatAxis, intrastatFlows, intrastatKind, valueOn } from './intrastat';

/*
 * The obligation closure's rules for goods across the border (core ro/trade): INS's Intrastat
 * declaration for each month the company is a data provider for a flow, filed with INS outside
 * the engine (`Intrastat.arrivals`, `Intrastat.dispatches`, due on the 15th of the next month).
 * The year's determination decides it; a provider the books show but nobody recorded is a need
 * (confirm the determination), a recorded value the computation contradicts a conflict. The VAT
 * returns of these operations (D300, D390) follow from the general rules.
 */

const lastDay = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);

export function tradeClosureRules(input: ClosureInput, months: readonly string[]): ClosureRule[] {
  const rules: ClosureRule[] = [];
  for (const month of months) {
    const year = Number(month.slice(0, 4));
    for (const flow of intrastatFlows) {
      const axis = intrastatAxis(flow);
      const determination = input.determinations.find(
        (item) => item.axis === axis && item.year === year,
      );
      if (!determination || determination.status === 'not_applicable') continue;
      const end = lastDay(month);
      rules.push({
        id: `obligation.intrastat.${flow}@${month}`,
        clauses: ['INS/Intrastat:norme.obligati', 'INS/Intrastat:termen'],
        reads: [],
        derives: [],
        run(_read, emit) {
          const kind = intrastatKind(flow);
          if (determination.status === 'needs_evidence' || determination.status === 'rule_gap') {
            emit.obligation({
              kind,
              deadline: 'Intrastat',
              period: month,
              deadlinePeriod: null,
              state: 'needs_evidence',
              blockers: determination.questions.map((question) =>
                emit.need({
                  code: 'DETERMINATION_MISSING',
                  fact: `${axis}/${year}`,
                  message: determination.summary,
                  question,
                }),
              ),
            });
            return;
          }
          if (determination.status !== 'proposed') return;
          const computed = valueOn(determination, end);
          const recorded = recordedAt(input.facts, axis, end);
          if (computed !== 'provider' && recorded !== 'provider') return;
          const confirmed = input.confirmed[`${axis}/${year}`] === determination.fingerprint;
          if (recorded === computed || confirmed) {
            if ((confirmed ? computed : recorded) === 'provider')
              emit.obligation({
                kind,
                deadline: 'Intrastat',
                period: month,
                deadlinePeriod: null,
                state: 'applies',
                blockers: [],
              });
            return;
          }
          emit.obligation({
            kind,
            deadline: 'Intrastat',
            period: month,
            deadlinePeriod: null,
            state: 'needs_evidence',
            blockers: [
              emit.need({
                code: recorded === null ? 'DETERMINATION_MISSING' : 'DETERMINATION_CONFLICT',
                fact: `${axis}/${year}`,
                message: `${axis} ${recorded === null ? 'nu este înregistrat' : 'înregistrat diferă de calcul'} pentru ${month}: ${determination.summary}`,
                question: confirmQuestion(determination),
              }),
            ],
          });
        },
      });
    }
  }
  return rules;
}
