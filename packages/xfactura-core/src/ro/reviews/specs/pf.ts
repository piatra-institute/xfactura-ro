import { parseMoney } from '../../../money';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import { monthEnd, monthStart, type LocalDate, type Month } from '../../../time';
import { obligationDue } from '../../obligations';
import { d112Filing, quarterMonths } from '../../payroll/quarterly';
import {
  adjustedNorm,
  attributeSources,
  incomeTax,
  realSourceIncome,
  type NormaRule,
  type PitLimits,
  type Rounding,
  type SharedKey,
  type SourcesRule,
} from '../../pit';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { lei } from './world';

/*
 * Readings for the PFA, II and IF work and the quarterly D112 (docs/PFA_II_IF.md §7.9). Every
 * outcome is computed by the engine's own functions against the register under review.
 */

const rules = (register: ParameterRegister) => new RuleContext(register, 'preview');
const blocked = (error: unknown): CaseOutcome => {
  if (!(error instanceof RuleGapError)) throw error;
  return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
};

// ---------------------------------------------------------------------------------------------
// The quarterly D112's exception (Codul fiscal art. 147 alin. (11))

type Event = { month: string; kind: 'sick' | 'end' };

/** The day each month of the quarter is due, under the engine's schedule (`d112Filing`) or under
 * the alternative: sick leave brings only its own month forward. */
function quarterDues(
  register: ParameterRegister,
  quarter: string,
  events: readonly Event[],
  reading: 'engine' | 'alternative',
): CaseOutcome {
  try {
    const context = rules(register);
    const lines = quarterMonths(quarter).map((month) => {
      const forward =
        reading === 'engine'
          ? events.map((event) => event.month)
          : events
              .filter((event) => event.kind === 'end' || event.month === month)
              .map((event) => event.month);
      const filing = d112Filing(month, 'quarterly', forward);
      const months = filing.counted.includes('Q') ? quarterMonths(month) : [filing.counted];
      const due = obligationDue(
        filing.deadline,
        {
          start: monthStart(months[0] as Month),
          end: monthEnd(months.at(-1) as Month) as LocalDate,
        },
        context,
      ).due;
      return `${month}: ${due}`;
    });
    return { summary: `Termene: ${lines.join('; ')}`, lines };
  } catch (error) {
    return blocked(error);
  }
}

function d112Case(title: string, facts: string, quarter: string, events: Event[]): ReviewCase {
  return {
    title,
    facts: `Angajator care depune D112 trimestrial (art. 80 alin. (2), art. 147 alin. (4)). ${facts}`,
    run: (register) => ({
      engine: quarterDues(register, quarter, events, 'engine'),
      alternative: quarterDues(register, quarter, events, 'alternative'),
    }),
  };
}

export const d112QuarterlySpec: ReviewSpec = {
  key: 'ro.deadline.D112.quarterly',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 15,
  readings: {
    engine:
      'Când în trimestru un salariat are concediu medical sau îi încetează calitatea de asigurat, declarația acelei luni și cele ale lunilor dinaintea ei din trimestru se depun până la 25 a lunii următoare evenimentului; regula scrisă pentru încetarea în luna a doua se aplică și concediului medical. Plata rămâne la termenul trimestrial.',
    alternative:
      'Pentru concediul medical se depune devreme numai declarația lunii în care a intervenit; lunile anterioare ale trimestrului rămân la 25 a lunii următoare trimestrului, textul cerând și luna anterioară doar la încetarea calității de asigurat.',
  },
  question:
    'Art. 147 alin. (11) (și OPANAF nr. 605/2026 anexa nr. 6 cap. I): la un concediu medical în luna a doua a trimestrului, declarația primei luni se depune odată cu a doua (până la 25 a lunii a treia), ca la încetarea calității de asigurat, sau după trimestru?',
  context: ['ANAF/Cod-fiscal-consolidat:art.147(11)', 'OPANAF605/2026:anexa6.cap.I'],
  cases: [
    d112Case(
      'Concediu medical în august 2026',
      'Un salariat are concediu medical în 10–14 august 2026 (trimestrul III).',
      '2026-08',
      [{ month: '2026-08', kind: 'sick' }],
    ),
    d112Case(
      'Contract încetat în august 2026',
      'Contractul unui salariat încetează la 20 august 2026.',
      '2026-08',
      [{ month: '2026-08', kind: 'end' }],
    ),
    d112Case(
      'Concediu medical în iulie 2026',
      'Un salariat are concediu medical în iulie 2026, prima lună a trimestrului.',
      '2026-07',
      [{ month: '2026-07', kind: 'sick' }],
    ),
    d112Case(
      'Concediu medical în noiembrie 2026',
      'Un salariat are concediu medical în noiembrie 2026; termenul de 25 decembrie devine 21 decembrie.',
      '2026-11',
      [{ month: '2026-11', kind: 'sick' }],
    ),
  ],
  gaps: [
    'Plata contribuțiilor și a impozitului lunilor declarate devreme rămâne la termenul trimestrial: art. 80 alin. (2), 146 alin. (3), 168 alin. (3) și 220^6 alin. (1) nu trimit la alin. (11); nicio instrucțiune nu o spune expres.',
    'Opțiunea pentru depunerea lunară (art. 147 alin. (8)) se face prin formularele de înregistrare ale OPANAF nr. 1.699/2021 (rândul „Lunară prin opțiune”), care nu sunt înregistrate ca surse; motorul o citește din determinarea anului confirmată de persoană.',
    'Evenimentele sunt cele din registre: concediile medicale plătite prin statul de plată și contractele încetate; un concediu medical nesuportat prin statul de plată nu este văzut.',
  ],
};

// ---------------------------------------------------------------------------------------------
// Expenses common to several sources (OMFP nr. 3.254/2017 art. 3–5)

const A = '00000000-0000-4000-8000-00000000a001';
const B = '00000000-0000-4000-8000-00000000a002';

/** Each source's net income in 2026 with a shared 6,000 lei phone bill, under a key. */
function sharedNet(
  register: ParameterRegister,
  gross: { a: string; b: string },
  key: SharedKey | null,
): CaseOutcome {
  try {
    const context = rules(register);
    const at = '2026-01-01' as LocalDate;
    const rule = context.param<SourcesRule>('ro.pit.sources', 'fiscal_year_start', at);
    const limits = context.param<PitLimits>('ro.pit.limits', 'fiscal_year_start', at);
    const rounding = context.param<Rounding>('ro.pit.rounding', 'fiscal_year_start', at);
    const segments = [{ method: 'sistem_real' as const, from: at, to: '2026-12-31' as LocalDate }];
    const part = (account: string, amount: string) => ({
      nature: (amount.startsWith('-') ? 'expense.full' : 'income.activity') as never,
      account,
      flow: parseMoney(amount, 'RON'),
      date: '2026-06-01' as LocalDate,
    });
    const attributed = attributeSources({
      parts: [
        ...(gross.a !== '0' ? [part('704.A', gross.a)] : []),
        ...(gross.b !== '0' ? [part('704.B', gross.b)] : []),
        part('626', '-6000.00'),
      ],
      sources: [
        { sourceId: A, name: 'A', segments },
        { sourceId: B, name: 'B', segments },
      ],
      attribution: {
        accounts: [
          { match: '704.A', sourceId: A },
          { match: '704.B', sourceId: B },
        ],
        shared: [{ match: '626', key: key ?? { kind: 'gross' } }],
      },
      rule,
    });
    const blocking = attributed.issues.filter((issue) => issue.severity === 'block');
    if (blocking.length)
      return {
        summary: `Blocat: ${blocking.map((issue) => issue.code).join(', ')}`,
        lines: blocking.map((issue) => issue.message),
      };
    const lines = attributed.sources.map((source) => {
      const result = realSourceIncome(
        {
          parts: source.parts.map((item) => ({ nature: item.nature, flow: item.flow })),
          nonCash: [],
        },
        { limits, rounding, eurRate: null, persons: 1 },
      );
      const net = result.totals.net - result.totals.loss;
      return `Sursa ${source.sourceId === A ? 'A' : 'B'}: venit net ${lei(net)} lei`;
    });
    return { summary: `Calculat: ${lines.join('; ')}`, lines };
  } catch (error) {
    return blocked(error);
  }
}

function sharedCase(
  title: string,
  facts: string,
  gross: { a: string; b: string },
  stated: SharedKey,
): ReviewCase {
  return {
    title,
    facts: `PFA cu două surse în sistem real în 2026 (A și B) și o factură de telefon de 6.000 lei folosită pentru amândouă. ${facts}`,
    run: (register) => ({
      engine: sharedNet(register, gross, stated),
      alternative: sharedNet(register, gross, { kind: 'gross' }),
    }),
  };
}

export const pitSourcesSpec: ReviewSpec = {
  key: 'ro.pit.sources',
  kind: 'interpretation',
  act: 'OMFP3254/2017',
  minutes: 20,
  readings: {
    engine:
      'O cheltuială folosită pentru mai multe surse de venit ale aceleiași persoane se repartizează după cheia aleasă și documentată de persoană: proporțional cu venitul brut al fiecărei surse sau pe cote fixe; fără o cheie declarată, registrul de evidență fiscală nu se încheie.',
    alternative:
      'Cheltuielile comune se repartizează numai proporțional cu ponderea venitului brut al fiecărei surse în venitul brut total, ca la cheltuielile comune din normele titlului II, oricare ar fi cheia declarată.',
  },
  question:
    'OMFP nr. 3.254/2017 cere registrul de evidență fiscală pe fiecare sursă (art. 3 alin. (3)–(4), art. 4–5) fără a spune cum se împart cheltuielile comune: este admisă cheia documentată de contribuabil (cote fixe), sau numai repartizarea după venitul brut?',
  context: [],
  cases: [
    sharedCase(
      'Cheie după venitul brut',
      'A încasează 60.000 lei, B 40.000 lei; persoana declară repartizarea după venitul brut.',
      { a: '60000.00', b: '40000.00' },
      { kind: 'gross' },
    ),
    sharedCase(
      'Cote fixe egale',
      'A încasează 60.000 lei, B 40.000 lei; persoana declară 50% / 50% (suprafața folosită).',
      { a: '60000.00', b: '40000.00' },
      {
        kind: 'fixed',
        shares: [
          { sourceId: A, percent: '50' },
          { sourceId: B, percent: '50' },
        ],
      },
    ),
    sharedCase(
      'O sursă fără încasări',
      'A încasează 50.000 lei, B nimic în 2026 (abia începută); persoana declară 80% / 20%.',
      { a: '50000.00', b: '0' },
      {
        kind: 'fixed',
        shares: [
          { sourceId: A, percent: '80' },
          { sourceId: B, percent: '20' },
        ],
      },
    ),
  ],
  gaps: [
    'Nicio normă a titlului IV nu stabilește o cheie: normele titlului II (pct. 4 și art. 23 lit. h)) repartizează cheltuielile comune proporțional cu veniturile, dar pentru impozitul pe profit; analogia nu este citită ca regulă.',
    'Limitele în euro pe persoană (art. 68 alin. (5)) nu se înmulțesc cu numărul surselor: motorul refuză aceeași cheltuială limitată pe mai multe surse (PIT_LIMIT_SOURCES).',
    'Atribuirea pe surse se face după contul (cu analiticul lui) pe care s-a înregistrat încasarea sau plata, cum o indică persoana, cu documentul ei.',
  ],
};

// ---------------------------------------------------------------------------------------------
// An IF on a norm: each member's norm (art. 69 alin. (3); norme pct. 8 alin. (5))

type Member = { quota: string; reduction?: string };

function memberNorms(
  register: ParameterRegister,
  norm: string,
  members: readonly Member[],
  reading: 'engine' | 'alternative',
): CaseOutcome {
  try {
    const context = rules(register);
    const at = '2026-01-01' as LocalDate;
    const rule = context.param<NormaRule>('ro.pit.norma', 'fiscal_year_start', at);
    const wage = parseMoney(
      context.param<string>('ro.min_wage.contributions', 'fiscal_year_start', at),
      'RON',
    );
    const rounding = context.param<Rounding>('ro.pit.rounding', 'fiscal_year_start', at);
    const rate = context.param<string>('ro.pit.rate', 'fiscal_year_start', at);
    const floor = wage * BigInt(rule.floorWages);
    const whole = parseMoney(norm, 'RON');
    const lines = members.map((member, index) => {
      const own =
        reading === 'engine'
          ? whole
          : (whole * BigInt(Math.round(Number(member.quota) * 100))) / 10_000n;
      const base = reading === 'alternative' && own < floor ? floor : own;
      const adjusted = adjustedNorm(
        {
          norm: base,
          increasePercent: null,
          reductionPercent: member.reduction ?? null,
          activeDays: null,
          floor,
        },
        rounding,
      );
      return `Membrul ${index + 1} (cota ${member.quota}%): normă ${lei(adjusted.adjusted)} lei, impozit ${lei(incomeTax(adjusted.adjusted, rate, rounding))} lei`;
    });
    return { summary: `Calculat: ${lines.join('; ')}`, lines };
  } catch (error) {
    return blocked(error);
  }
}

function memberCase(title: string, facts: string, norm: string, members: Member[]): ReviewCase {
  return {
    title,
    facts: `Întreprindere familială impusă pe bază de normă în 2026; norma publicată de DGRFP pentru activitate și loc: ${norm.replace('.00', '')} lei. ${facts}`,
    run: (register) => ({
      engine: memberNorms(register, norm, members, 'engine'),
      alternative: memberNorms(register, norm, members, 'alternative'),
    }),
  };
}

export const pitNormaSpec: ReviewSpec = {
  key: 'ro.pit.norma',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 20,
  readings: {
    engine:
      'Într-o întreprindere familială impusă pe bază de normă, fiecare membru datorează norma întreagă publicată pentru activitate și loc, cu coeficienții săi de corecție („norma de venit fiind stabilită pentru fiecare membru asociat”, art. 69 alin. (3)); D212 al membrului rămâne refuzat (D212_IF_NORMA) până la răspuns.',
    alternative:
      'Norma publicată pentru activitate se împarte între membri după cotele din acordul de constituire; partea fiecăruia este de cel puțin 12 salarii minime (norme pct. 8 alin. (5)), apoi fiecare aplică propriii coeficienți.',
  },
  question:
    'Membrii unei întreprinderi familiale impuse pe bază de normă datorează fiecare norma întreagă a activității, sau o parte a ei după cota din acord, de cel puțin 12 salarii minime?',
  context: ['ANAF/Cod-fiscal-consolidat:norme.art.69.pct.8(5)'],
  cases: [
    memberCase('Doi membri, cote egale', 'Doi membri, 50% / 50%.', '60000.00', [
      { quota: '50' },
      { quota: '50' },
    ]),
    memberCase('Trei membri', 'Trei membri, 40% / 30% / 30%.', '150000.00', [
      { quota: '40' },
      { quota: '30' },
      { quota: '30' },
    ]),
    memberCase(
      'Un coeficient de reducere al unui membru',
      'Doi membri, 70% / 30%; al doilea are un coeficient de reducere de 20% (criteriul 05).',
      '100000.00',
      [{ quota: '70' }, { quota: '30', reduction: '20' }],
    ),
  ],
  gaps: [
    'Plafonul minim de 12 salarii pe membru (art. 69 alin. (3), norme pct. 8 alin. (5)) ar fi redundant dacă fiecare membru datorează norma întreagă (normele publicate respectă deja plafonul); acesta e argumentul citirii alternative.',
    'Normele (pct. 8 alin. (5)) încă spun salariul minim „în vigoare la momentul stabilirii” normei; Codul, de la veniturile din 2026, salariul de la 1 ianuarie (Legea nr. 239/2025 art. XII pct. 6).',
    'Pentru veniturile din 2025, plafonul se calculează cu salariul minim în vigoare la data deciziei DGRFP (forma consolidată din 2025 a portalului legislativ, de dinainte de Legea nr. 239/2025): persoana indică data; o dată fără salariu în registru este RULE_GAP.',
  ],
};
