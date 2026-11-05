import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { halfYearReport } from '../../annual/half-year';
import { obligationDue } from '../../obligations';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';

/*
 * Readings of the annual statements the texts leave open (src/ro/annual): which deadline binds
 * a company's statements of 2025 when the accounting law and the order disagree, and who reports
 * at 30 June. Each case runs the engine's code on a fixed year.
 */

const rulesOf = (register: ParameterRegister) => new RuleContext(register, 'preview');
const year = (value: number) => ({
  start: `${value}-01-01` as LocalDate,
  end: `${value}-12-31` as LocalDate,
});

function deadlineCase(title: string, facts: string, reportingYear: number): ReviewCase {
  return {
    title,
    facts,
    run(register) {
      const due = obligationDue('S1003', year(reportingYear), rulesOf(register));
      const readings = due.conflict ?? [{ nominal: due.nominal, due: due.due, clauses: [] }];
      const order = readings.find((reading) =>
        reading.clauses.some((clause) => clause.startsWith('OMF')),
      );
      const engine: CaseOutcome = {
        summary: `Termen: ${due.due}`,
        lines: readings.map(
          (reading) =>
            `${reading.clauses.join(', ') || 'Legea 82/1991'}: ${reading.nominal} → ${reading.due}`,
        ),
      };
      const alternative: CaseOutcome = order
        ? {
            summary: `Termen: ${order.due}`,
            lines: [`Ordinul anual prevalează: ${order.nominal} → ${order.due}.`],
          }
        : { summary: `Termen: ${due.due}`, lines: ['Niciun ordin pentru an: doar legea.'] };
      return { engine, alternative };
    },
  };
}

export const statementsDeadlineSpec: ReviewSpec = {
  key: 'ro.deadline.S1003',
  kind: 'interpretation',
  act: 'OMF2036/2025',
  minutes: 15,
  readings: {
    engine:
      'Legea contabilității (150 de zile de la încheierea exercițiului) și OMF nr. 2.036/2025 (31 mai) dau termene diferite; aplicația nu alege: le arată pe amândouă și cere depunerea până la cel mai devreme dintre ele.',
    alternative:
      'Ordinul anual, care stabilește data concretă pentru exercițiul respectiv, prevalează asupra numărului de zile din lege: termenul este 31 mai (prima zi lucrătoare după).',
  },
  question:
    'Pentru situațiile financiare ale unei societăți din 2025, termenul de depunere este a 150-a zi de la încheierea exercițiului (30 mai) sau 31 mai, cum spune OMF nr. 2.036/2025? Pentru 2026, cât timp nu este publicat ordinul anual, se aplică doar cele 150 de zile?',
  context: [],
  cases: [
    deadlineCase(
      'Exercițiul 2025',
      'Situațiile financiare ale unei SRL pentru exercițiul încheiat la 31.12.2025; 30 mai 2026 este sâmbătă, 31 mai duminică, 1 iunie zi liberă.',
      2025,
    ),
    deadlineCase(
      'Exercițiul 2026, fără ordin publicat',
      'Situațiile financiare ale unei SRL pentru exercițiul încheiat la 31.12.2026, înainte de publicarea ordinului pentru 2026.',
      2026,
    ),
    deadlineCase(
      'Microentitate (S1005), exercițiul 2025',
      'Aceeași regulă pentru S1005: aplicația folosește aceleași două lecturi pentru micro și pentru entitățile mici.',
      2025,
    ),
  ],
  gaps: [
    'Mutarea termenului dintr-o zi nelucrătoare urmează OMF nr. 2.036/2025 pct. 3.1 alin. (3) și regula generală a procedurii fiscale; zilele libere legale sunt cele din calendarul aplicației.',
    'Ordinul pentru 2026 nu este publicat; când va fi, termenul lui se adaugă ca o nouă lectură.',
  ],
};

function halfYearCase(
  title: string,
  facts: string,
  reportingYear: number,
  turnover: string,
  rate: string,
): ReviewCase {
  return {
    title,
    facts,
    run(register) {
      const bani = BigInt(Math.round(Number(turnover) * 100));
      const decision = halfYearReport(
        reportingYear,
        {
          previousNetTurnover: bani,
          rate: { rate, date: `${reportingYear - 1}-12-31` },
          excluded: null,
        },
        rulesOf(register),
      );
      const engine: CaseOutcome = {
        summary:
          decision.status === 'required'
            ? `Se întocmește, până la ${decision.due}`
            : 'Nu se întocmește',
        lines: decision.lines,
      };
      // The alternative: a reporting obligation kept every year, at 1.000.000 € and 30 June.
      const limit = 1_000_000 * Number(rate);
      const alternative: CaseOutcome = {
        summary: Number(turnover) > limit ? 'Se întocmește' : 'Nu se întocmește',
        lines: [`Pragul de 1.000.000 € aplicat și în ${reportingYear}: ${limit.toFixed(2)} lei.`],
      };
      return { engine, alternative };
    },
  };
}

export const halfYearSpec: ReviewSpec = {
  key: 'ro.halfyear.report',
  kind: 'interpretation',
  act: 'OMF1194/2025',
  minutes: 10,
  readings: {
    engine:
      'Raportarea la 30 iunie există doar în anii în care ministrul o cere prin ordin: în 2025 pentru cifra de afaceri netă a anului precedent peste 1.000.000 €, în 2026 deloc, căci ordinul nu a fost emis și ANAF nu publică S1027–S1050.',
    alternative:
      'Raportarea la 30 iunie este o obligație anuală pentru cei peste 1.000.000 €, și în lipsa ordinului pentru 2026.',
  },
  question:
    'Pentru 30 iunie 2026, în lipsa unui ordin al ministrului finanțelor și a formularelor ANAF S1027–S1050, este corect că nicio entitate nu întocmește raportarea contabilă semestrială?',
  context: [],
  cases: [
    halfYearCase(
      '2025, peste prag',
      'Cifra de afaceri netă 2024: 5.200.000 lei; curs ipotetic al EUR la 31.12.2024: 4,9741 lei.',
      2025,
      '5200000',
      '4.9741',
    ),
    halfYearCase(
      '2025, sub prag',
      'Cifra de afaceri netă 2024: 4.800.000 lei; curs ipotetic al EUR la 31.12.2024: 4,9741 lei.',
      2025,
      '4800000',
      '4.9741',
    ),
    halfYearCase(
      '2026, peste prag, fără ordin',
      'Cifra de afaceri netă 2025: 5.200.000 lei; curs ipotetic 5,0800 lei/€.',
      2026,
      '5200000',
      '5.0800',
    ),
  ],
  gaps: [
    'Comunicatul Ministerului Finanțelor privind renunțarea la raportarea din 2026 nu a fost citit pe site-ul ministerului; lectura se sprijină pe lipsa ordinului și a formularelor din pagina ANAF.',
    'Cursurile din cazuri sunt ipotetice; în aplicație cursul BNR valabil la încheierea exercițiului precedent se ia din cursurile importate.',
  ],
};
