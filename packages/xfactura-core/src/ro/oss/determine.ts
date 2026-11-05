import type { RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import {
  Draft,
  factQuestionFrom,
  guarded,
  lei,
  recordedAt,
  WATCH_PERCENT,
  type Determination,
  type DeterminationContext,
  type Known,
  type ThresholdWatch,
} from '../determinations/determine';
import type { DistanceThreshold } from './parameters';

/*
 * The yearly determinations of sales to consumers in other Member States:
 * - `vat.distance`: where the place of supply is (Codul fiscal art. 278^1): in Romania while the
 *   year's and the previous year's sales stay within the threshold and the company has not opted;
 *   at the destination from the sale that exceeds it, from 1 January after a year above it, or by
 *   the option, which holds for at least two calendar years;
 * - `vat.oss`: the Union scheme (art. 315), needed once the place is the destination: without it
 *   the company owes VAT in each Member State, which the engine does not keep;
 * - `vat.ioss`: the import scheme (art. 315^2), for goods imported in consignments up to 150 €:
 *   not covered.
 * Nothing is defaulted: an unknown fact is asked, an uncovered case UNSUPPORTED.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const code = (clause: string) => `${CODE}:${clause}`;

/** A sale of art. 278^1 alin. (1) lit. b) as the books hold it, by tax point. */
export interface DistanceSale {
  date: LocalDate;
  documentId: string;
  number: string;
  /** The base in lei, without VAT; negative for a credit note. */
  base: bigint;
  regime: 'origin' | 'oss';
  country: string;
}

const salesOf = (context: DeterminationContext): readonly DistanceSale[] =>
  [...(context.activity.distance ?? [])].sort((a, b) => a.date.localeCompare(b.date));

/** The first day the year's sales exceed the threshold, and the total up to then or the year's. */
export function distanceCrossing(
  sales: readonly DistanceSale[],
  limit: bigint,
): { total: bigint; crossed: LocalDate | null; document: DistanceSale | null } {
  let total = 0n;
  for (const sale of sales) {
    total += sale.base;
    if (total > limit) return { total, crossed: sale.date, document: sale };
  }
  return { total, crossed: null, document: null };
}

/** The place of supply of distance sales and TBE services to consumers (art. 278^1). */
export function determineVatDistance(
  context: DeterminationContext,
  rules: RuleContext,
): Determination {
  const year = context.year;
  const draft = new Draft('vat.distance', year, rules);
  const start = (context.activity.start ?? `${year}-01-01`) as LocalDate;
  return guarded(draft, () => {
    const sales = salesOf(context);
    const recorded = context.facts.filter(
      (fact) => fact.axis === 'vat.distance' && fact.effectiveFrom <= `${year}-12-31`,
    );
    if (!sales.length && !recorded.length)
      return draft.notApplicable(
        `Registrele nu au în ${year} vânzări la distanță sau servicii electronice către consumatori din alte state membre.`,
      );
    const threshold = draft.param<DistanceThreshold>(
      'ro.vat.distance.threshold',
      'reporting_period_start',
      `${year}-01-01`,
    );
    const optionYears = draft.param<number>(
      'ro.vat.distance.option_years',
      'reporting_period_start',
      `${year}-01-01`,
    );
    draft.cite(
      code('art.278^1(1)-(2)'),
      code('art.278^1(5)'),
      code('art.275(2)'),
      code('art.278(5)(h)'),
    );
    const limit = BigInt(threshold.lei) * 100n;
    draft.inputs.threshold = { lei: threshold.lei, eur: threshold.eur };
    // The option of art. 278^1 alin. (3): from its date, for at least two calendar years.
    const option = recorded
      .filter((fact) => fact.value === 'option')
      .find((fact) => Number(fact.effectiveFrom.slice(0, 4)) + optionYears - 1 >= year);
    if (option) {
      draft.cite(code('art.278^1(3)'));
      const from = (option.effectiveFrom > start ? option.effectiveFrom : start) as LocalDate;
      draft.inputs.option = { from: option.effectiveFrom };
      draft.line(
        `Opțiunea pentru locul la destinație din ${option.effectiveFrom} se aplică cel puțin ${optionYears} ani calendaristici (art. 278^1 alin. (3)), deci și în ${year}.`,
      );
      if (from === start)
        return draft.finish(
          'proposed',
          'option',
          start,
          `Locul la destinație în ${year}, prin opțiune.`,
        );
      draft.changes.push({
        value: 'option',
        effectiveFrom: from,
        reason: 'opțiunea art. 278^1 alin. (3)',
      });
    }
    // A company set up during the year had no sales the year before (art. 278^1 alin. (1) lit. c)).
    const previous = draft.known<bigint>(
      'previousYear',
      context.activity.start
        ? {
            known: true,
            value: 0n,
            source: 'books',
            ref: `înființată la ${context.activity.start}`,
          }
        : (context.previous.distanceTurnover ?? {
            known: false,
            reason: `Vânzările la distanță și serviciile electronice către consumatori din ${year - 1} nu sunt cunoscute.`,
            question: null,
          }),
      (value) => lei(value),
    );
    if (previous === undefined)
      return draft.needs(
        `Valoarea vânzărilor la distanță și a serviciilor electronice către consumatori din alte state membre din ${year - 1} nu este cunoscută: pragul se verifică și pe anul precedent (art. 278^1 alin. (1) lit. c)).`,
      );
    draft.line(
      `${year - 1}: ${lei(previous)} lei față de pragul de ${lei(limit)} lei (${threshold.eur} €).`,
    );
    if (previous > limit) {
      draft.line(
        `Pragul a fost depășit în ${year - 1}: în ${year} locul este la destinație de la 1 ianuarie (art. 278^1 alin. (1) lit. c)).`,
      );
      return draft.finish(
        'proposed',
        'destination',
        start,
        `Locul la destinație în ${year}: pragul depășit în ${year - 1}.`,
      );
    }
    const { total, crossed, document } = distanceCrossing(sales, limit);
    draft.inputs.currentYear = lei(total);
    draft.inputs.crossed = crossed;
    draft.line(
      `${year}${crossed ? ` până la ${crossed}` : ''}: ${lei(total)} lei față de pragul de ${lei(limit)} lei.`,
    );
    if (crossed && !(option && option.effectiveFrom <= crossed)) {
      draft.changes.push({
        value: 'destination',
        effectiveFrom: crossed,
        reason: `pragul de ${threshold.lei} lei este depășit prin factura ${document!.number} din ${crossed}: locul este la destinație de la această vânzare (art. 278^1 alin. (2))`,
      });
      draft.line(
        `Factura ${document!.number} din ${crossed} depășește pragul: de la ea locul este în statul membru al clientului (art. 278^1 alin. (2)); TVA se declară în regimul special Uniune (art. 315) sau în fiecare stat membru.`,
      );
    }
    return draft.finish(
      'proposed',
      'origin',
      start,
      crossed
        ? `Locul în România până la ${crossed}, la destinație de atunci (art. 278^1 alin. (2)).`
        : `Locul în România în ${year}: sub pragul de ${threshold.lei} lei.`,
    );
  });
}

/** The first day the place is the destination in the year's determination, if it is. */
export function destinationFrom(distance: Determination): LocalDate | null {
  if (distance.status !== 'proposed') return null;
  if (distance.value !== 'origin') return distance.effectiveFrom;
  return (distance.changes.find((change) => change.value !== 'origin')?.effectiveFrom ??
    null) as LocalDate | null;
}

/** The Union scheme (art. 315): needed once the place is the destination. */
export function determineVatOss(context: DeterminationContext, rules: RuleContext): Determination {
  const year = context.year;
  const draft = new Draft('vat.oss', year, rules);
  const start = (context.activity.start ?? `${year}-01-01`) as LocalDate;
  return guarded(draft, () => {
    const distance = determineVatDistance(context, rules);
    const from = destinationFrom(distance);
    const recorded = recordedAt(context.facts, 'vat.oss', `${year}-12-31`);
    const fact = context.facts
      .filter((item) => item.axis === 'vat.oss' && item.effectiveFrom <= `${year}-12-31`)
      .at(-1);
    draft.cite(code('art.315(1)-(2^1)'), code('art.315(3)-(5)'), 'REG282/2011-A:art.57d');
    if (distance.status === 'needs_evidence')
      return draft.needs(
        `Locul vânzărilor către consumatori din alte state membre nu se poate stabili: ${distance.summary}`,
      );
    if (!from && !recorded)
      return draft.notApplicable(
        `Locul vânzărilor către consumatori din alte state membre rămâne în România în ${year}: regimul special Uniune nu este necesar.`,
      );
    if (recorded === 'non_union')
      return draft.finish(
        'unsupported',
        null,
        start,
        'Regimul non-Uniune nu este al unei firme stabilite în România.',
        {
          trigger: 'OSS_NON_UNION',
          message:
            'Regimul special non-Uniune (art. 314) îl folosește numai persoana impozabilă fără sediul activității economice și fără sediu fix în Uniunea Europeană: o firmă stabilită în România aplică regimul Uniune (art. 315).',
          capabilities: ['OSS_NON_UNION'],
        },
      );
    if (from) {
      draft.inputs.destinationFrom = from;
      draft.line(`Locul este la destinație de la ${from} (${distance.summary}).`);
      const atFrom = recordedAt(context.facts, 'vat.oss', from);
      if (!recorded)
        return draft.needs(
          `Locul vânzărilor este la destinație de la ${from}: înregistrați dacă firma aplică regimul special Uniune (vat.oss = union, cu decizia ANAF) sau nu (none). Regimul se aplică de la prima vânzare în regim dacă ANAF a fost informată până pe 10 a lunii următoare, altfel din prima zi a trimestrului următor informării (Regulamentul (UE) nr. 282/2011 art. 57d).`,
          factQuestionFrom('vat.oss', from),
        );
      if (recorded !== 'union' || atFrom !== 'union') {
        const late = recorded === 'union' && atFrom !== 'union';
        return draft.finish(
          'unsupported',
          null,
          start,
          late
            ? `Regimul special Uniune începe la ${fact!.effectiveFrom}, după ${from}.`
            : 'Firma nu aplică regimul special Uniune.',
          {
            trigger: 'EU_DESTINATION_VAT_UNREGISTERED',
            message: late
              ? `Vânzările cu locul la destinație dintre ${from} și ${fact!.effectiveFrom}, înainte de regimul special Uniune, se declară în fiecare stat membru de consum, prin înregistrarea acolo: aplicația nu ține aceste înregistrări. Dacă ANAF a fost informată până pe 10 a lunii următoare primei vânzări în regim, regimul se aplică de la acea vânzare (Regulamentul (UE) nr. 282/2011 art. 57d): înregistrați vat.oss = union de la ea.`
              : `Locul vânzărilor este la destinație de la ${from} și firma nu aplică regimul special Uniune: TVA se datorează în fiecare stat membru de consum, prin înregistrarea acolo, pe care aplicația nu o ține.`,
            capabilities: ['FOREIGN_VAT_REGISTRATION'],
          },
        );
      }
    }
    draft.line(
      `Regimul special Uniune este înregistrat de la ${fact!.effectiveFrom}: declarația specială de TVA (398) se depune trimestrial, cu sau fără operațiuni (art. 315 alin. (6)).`,
    );
    draft.cite(code('art.315(6)-(6^1)'));
    const effective = (fact!.effectiveFrom > start ? fact!.effectiveFrom : start) as LocalDate;
    return draft.finish(
      'proposed',
      recorded,
      effective,
      `Regimul special Uniune în ${year}: ${recorded}${recorded === 'union' ? `, de la ${effective}` : ''}.`,
    );
  });
}

/** The import scheme (art. 315^2): not covered. */
export function determineVatIoss(context: DeterminationContext, rules: RuleContext): Determination {
  const year = context.year;
  const draft = new Draft('vat.ioss', year, rules);
  const start = (context.activity.start ?? `${year}-01-01`) as LocalDate;
  return guarded(draft, () => {
    const recorded = recordedAt(context.facts, 'vat.ioss', `${year}-12-31`);
    const goods = recordedAt(context.facts, 'activity.goods', `${year}-12-31`);
    if (recorded === 'registered' || recorded === 'intermediary') {
      const rule = draft.param<{ consignmentLimitEur: string }>(
        'ro.vat.ioss',
        'reporting_period_start',
        `${year}-01-01`,
      );
      draft.cite(code('art.315^2(1)-(3)'), code('art.315^2(18)-(23)'));
      return draft.finish(
        'unsupported',
        null,
        start,
        'Regimul special de import (IOSS) nu este acoperit.',
        {
          trigger: 'IOSS_SCHEME',
          message: `Regimul special de import (art. 315^2) privește vânzările la distanță de bunuri importate din țări terțe în loturi de cel mult ${rule.consignmentLimitEur} €, cu declarație lunară în euro: importurile, vama și stocurile nu sunt construite, iar pentru o firmă mică fără stocuri regimul nu se aplică.`,
          capabilities: ['IOSS_RETURN', 'IMPORTS', 'STOCK'],
        },
      );
    }
    if (recorded === 'none')
      return draft.finish('proposed', 'none', start, `Fără regimul special de import în ${year}.`);
    if (goods === 'yes')
      return draft.needs(
        'Firma are activitate cu bunuri: înregistrați dacă vinde la distanță bunuri importate prin regimul special de import (vat.ioss).',
        factQuestionFrom('vat.ioss', start),
      );
    return draft.notApplicable(
      'Firma nu declară activitate cu bunuri: regimul special de import (art. 315^2) nu o privește.',
    );
  });
}

/** The threshold of art. 278^1 at `WATCH_PERCENT` or more, while the place is still in Romania. */
export function distanceWatch(
  context: DeterminationContext,
  rules: RuleContext,
  at: string,
): Omit<ThresholdWatch, 'percent' | 'year'> | null {
  const sales = salesOf(context);
  if (!sales.length) return null;
  const place = recordedAt(context.facts, 'vat.distance', at);
  if (place && place !== 'origin') return null;
  const threshold = rules.param<DistanceThreshold>(
    'ro.vat.distance.threshold',
    'reporting_period_start',
    `${context.year}-01-01` as LocalDate,
  );
  const value = sales.reduce((sum, sale) => sum + sale.base, 0n);
  const limit = BigInt(threshold.lei) * 100n;
  if (value * 100n < limit * BigInt(WATCH_PERCENT)) return null;
  return {
    key: 'ro.vat.distance.threshold',
    axis: 'vat.distance',
    limit,
    value,
    clauses: [code('art.278^1(1)-(2)'), code('art.278^1(5)')],
    message: `Vânzările la distanță și serviciile electronice către consumatori din alte state membre din ${context.year}, ${lei(value)} lei, față de pragul de ${threshold.lei} lei (${threshold.eur} €, art. 278^1): peste el, locul este la destinație și TVA se declară în regimul special Uniune (D398).`,
  };
}

/** A previous year's total, as the determination reads it. */
export type DistanceTurnover = Known<bigint>;
