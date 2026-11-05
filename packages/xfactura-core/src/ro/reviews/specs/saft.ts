import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import type { ProfileFact } from '../../../kernel';
import { obligationDue } from '../../obligations';
import { d406Begun } from '../../saft/applicability';
import {
  calculateD406Assets,
  type D406AssetCard,
  type D406AssetsPresentation,
} from '../../saft/assets';
import type { D406Start } from '../../saft/parameters';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';

/*
 * Readings of D406 (src/ro/saft) the texts leave open: when the annual assets file is due and in
 * what order, from when a taxpayer category files, and how the assets file writes the fields
 * ANAF's documents disagree on. Every outcome is computed by the engine's own functions against
 * the register under review.
 */

const rules = (register: ParameterRegister) => new RuleContext(register, 'preview');
const blocked = (error: unknown): CaseOutcome => {
  if (!(error instanceof RuleGapError)) throw error;
  return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
};
const year = (value: number) => ({
  start: `${value}-01-01` as LocalDate,
  end: `${value}-12-31` as LocalDate,
});

// ---------------------------------------------------------------------------------------------
// The annual assets file's deadline (OPANAF nr. 1.783/2021 anexa nr. 4 pct. 1, 7)

function deadlineCase(title: string, facts: string, reportingYear: number): ReviewCase {
  return {
    title,
    facts,
    run(register) {
      try {
        const due = obligationDue('D406.assets', year(reportingYear), rules(register));
        const readings = due.conflict ?? [{ nominal: due.nominal, due: due.due, clauses: [] }];
        const order = readings.find((reading) =>
          reading.clauses.some((clause) => clause.startsWith('OMF')),
        );
        return {
          engine: {
            summary: `Termen: ${due.due}, după toate D406 lunare sau trimestriale ale exercițiului`,
            lines: readings.map(
              (reading) =>
                `${reading.clauses.filter((clause) => !clause.startsWith('ANAF/') && !clause.startsWith('OPANAF')).join(', ') || 'Legea 82/1991'}: ${reading.nominal} → ${reading.due}`,
            ),
          },
          alternative: {
            summary: `Termen: ${(order ?? readings[0]!).due}, oricând până atunci`,
            lines: [
              order
                ? `Ordinul anual prevalează: ${order.nominal} → ${order.due}.`
                : 'Niciun ordin pentru an: doar legea.',
              'Ordinea față de declarațiile periodice nu condiționează depunerea.',
            ],
          },
        };
      } catch (error) {
        const outcome = blocked(error);
        return { engine: outcome, alternative: outcome };
      }
    },
  };
}

export const d406AssetsDeadlineSpec: ReviewSpec = {
  key: 'ro.deadline.D406.assets',
  kind: 'interpretation',
  act: 'OPANAF1783/2021',
  minutes: 15,
  readings: {
    engine:
      'Declarația D406 pentru active urmează termenul situațiilor financiare (cu cele două lecturi pentru 2025, cea mai devreme fiind termenul) și se autorizează după declarațiile D406 periodice ale exercițiului, cum cere clarificarea ANAF din 14.11.2022.',
    alternative:
      'Termenul este cel din ordinul anual al situațiilor financiare (31 mai), iar ordinea față de declarațiile periodice este o recomandare, nu o condiție a depunerii.',
  },
  question:
    'Declarația D406 pentru active a exercițiului 2025 se depune până la a 150-a zi de la închiderea exercițiului sau până la 31 mai (OMF nr. 2.036/2025)? Trebuie depusă numai după ce toate declarațiile D406 lunare sau trimestriale ale exercițiului au fost depuse?',
  context: ['L82/1991:art.36(1)(a)', 'OMF2036/2025:anexa1.pct.3.1(1)(a)'],
  cases: [
    deadlineCase(
      'Exercițiul 2025',
      'O SRL cu mijloace fixe, exercițiul încheiat la 31.12.2025; 30 mai 2026 este sâmbătă, 31 mai duminică, 1 iunie zi liberă.',
      2025,
    ),
    deadlineCase(
      'Exercițiul 2026, fără ordin publicat',
      'Aceeași SRL, exercițiul încheiat la 31.12.2026, înainte de publicarea ordinului pentru 2026.',
      2026,
    ),
    deadlineCase(
      'Exercițiul 2025, D406 de decembrie depus în ianuarie',
      'Declarația D406 a lunii decembrie 2025 este depusă la 31.01.2026, fără active; cea pentru active urmează până la termenul situațiilor financiare.',
      2025,
    ),
  ],
  gaps: [
    'Un prim exercițiu mai scurt de 12 luni nu are o regulă: validatorul ANAF (J2.2.8) respinge declarația pentru active pe altă perioadă decât 12 luni, iar aplicația o arată ca neacoperită.',
    'Declarațiile D406 periodice depuse în afara aplicației nu sunt văzute de condiția de ordine.',
  ],
};

// ---------------------------------------------------------------------------------------------
// From when each category files (OPANAF nr. 1.783/2021 anexa nr. 5 pct. 1–2)

const category = (value: string, from: string): ProfileFact =>
  ({
    id: `${value}-${from}`,
    axis: 'taxpayer.category',
    value,
    effectiveFrom: from as LocalDate,
    evidenceId: 'evidence',
  }) as unknown as ProfileFact;

function startCase(
  title: string,
  facts: string,
  categories: ProfileFact[],
  months: string[],
  alternative: (month: string) => boolean,
): ReviewCase {
  return {
    title,
    facts,
    run(register) {
      try {
        const start = rules(register).param<D406Start>(
          'ro.d406.start',
          'reporting_period_start',
          '2022-01-01' as LocalDate,
        );
        const engine = months.map((month) => {
          const begun = d406Begun(categories, start, `${month}-28`);
          return `${month}: ${begun.state === 'known' ? (begun.value ? 'D406' : 'fără D406') : 'necunoscut'}`;
        });
        return {
          engine: { summary: engine.join('; '), lines: engine },
          alternative: {
            summary: months
              .map((month) => `${month}: ${alternative(month) ? 'D406' : 'fără D406'}`)
              .join('; '),
            lines: ['Lectura alternativă din întrebare.'],
          },
        };
      } catch (error) {
        const outcome = blocked(error);
        return { engine: outcome, alternative: outcome };
      }
    },
  };
}

export const d406StartSpec: ReviewSpec = {
  key: 'ro.d406.start',
  kind: 'interpretation',
  act: 'OPANAF407/2025',
  minutes: 15,
  readings: {
    engine:
      'Fiecare încadrare înregistrată (faptul taxpayer.category, datat de la încadrare) începe D406 la data de referință a categoriei sau, dacă e mai târzie, la data încadrării; un mare contribuabil înregistrat de la 1 ianuarie 2022 este unul nou (de la 1 iulie 2022); după 1 ianuarie 2025 toate categoriile depun.',
    alternative:
      'Un mare contribuabil înregistrat de la 1 ianuarie 2022 depune tot de la 1 ianuarie 2022 (lit. a)), iar contribuabilul mijlociu din 2021 devenit mic în 2023 depune de la 1 ianuarie 2023.',
  },
  question:
    'Pentru lunile dinaintea anului 2025, se aplică datele de referință astfel: mare contribuabil din 2021 de la 1.01.2022, nou mare contribuabil de la 1.07.2022, mijlociu de la 1.01.2023, mic de la 1.01.2025, iar o încadrare ulterioară de la data ei? Un mijlociu din 2021 devenit mic în 2023 depune obligatoriu doar de la 1.01.2025?',
  context: [],
  cases: [
    startCase(
      'Contribuabil mic',
      'O SRL mică din 2020, cu registrele din 2024.',
      [category('small', '2020-01-01')],
      ['2024-06', '2025-01'],
      (month) => month >= '2025-01',
    ),
    startCase(
      'Mare contribuabil de la 1 ianuarie 2022',
      'O SRL încadrată la marii contribuabili la 1.01.2022, înregistrată de la acea dată.',
      [category('large', '2022-01-01')],
      ['2022-03', '2022-07'],
      () => true,
    ),
    startCase(
      'Mijlociu în 2021, mic din 2023',
      'O SRL mijlocie la 31.12.2021, care nu mai este mijlocie la 1.01.2023 (pct. 1.2 lit. a)).',
      [category('medium', '2021-01-01'), category('small', '2023-01-01')],
      ['2023-06', '2025-01'],
      (month) => month >= '2023-01',
    ),
  ],
  gaps: [
    'Opțiunea unui contribuabil mijlociu din 2021 de a depune înainte de 2025 (pct. 1.2 lit. a)) nu se derivă: ea devine efectivă prin depunerea unei D406 validate.',
    'Nerezidenții înregistrați doar în scop de TVA (lit. e)) și suspendarea activității (pct. 4 lit. o)) nu sunt reprezentate în aplicație.',
  ],
};

// ---------------------------------------------------------------------------------------------
// How the annual assets file writes the rate and the disposals

const asset = (overrides: Partial<D406AssetCard>): D406AssetCard => ({
  id: 'MF-1',
  account: '2131',
  depreciationAccount: '2813',
  description: 'Utilaj',
  acquired: '2024-12-10',
  commissioned: '2024-12-10',
  catalogCode: '2.1.16.1',
  lifeMonths: 48,
  costBegin: '12000.00',
  depreciationBegin: '3000.00',
  addition: '0.00',
  disposal: '0.00',
  depreciation: '3000.00',
  depreciationRemoved: '0.00',
  ...overrides,
});

function presentationCase(title: string, facts: string, card: D406AssetCard): ReviewCase {
  const outcome = (presentation: D406AssetsPresentation): CaseOutcome => {
    const [total] = calculateD406Assets({
      year: { start: '2026-01-01', end: '2026-12-31' },
      created: '2027-03-10',
      software: { company: 'xFactura', name: 'xFactura', version: '0' },
      company: {
        cui: '18547290',
        name: 'Exemplu SRL',
        address: { city: 'Galați', country: 'RO' },
        contact: { firstName: 'A', lastName: 'B', phone: '0' },
        ibans: [],
        vatRegime: '100010',
      },
      presentation,
      accounts: [],
      assets: [card],
      transactions: [],
    });
    return {
      summary: `DepreciationPercentage ${total!.percentage}, AssetDisposal ${(Number(total!.disposal) / 100).toFixed(2)}`,
      lines: [
        `AssetLife${'years' in total!.life ? `Year ${total!.life.years}` : `Month ${total!.life.months}`}`,
        `BookValueEnd ${(Number(total!.bookValueEnd) / 100).toFixed(2)}`,
      ],
    };
  };
  return {
    title,
    facts,
    run(register) {
      try {
        const presentation = rules(register).param<D406AssetsPresentation>(
          'ro.d406.assets.presentation',
          'reporting_period_start',
          '2026-01-01' as LocalDate,
        );
        return {
          engine: outcome(presentation),
          alternative: outcome({
            percentage: presentation.percentage === 'percent' ? 'fraction' : 'percent',
            disposal: presentation.disposal === 'gross' ? 'net' : 'gross',
          }),
        };
      } catch (error) {
        const result = blocked(error);
        return { engine: result, alternative: result };
      }
    },
  };
}

export const d406PresentationSpec: ReviewSpec = {
  key: 'ro.d406.assets.presentation',
  kind: 'interpretation',
  act: 'ANAF/SAFT_FAQ_2022',
  minutes: 20,
  readings: {
    engine:
      'Rata de amortizare se scrie în procente (răspunsul ANAF la MF.A.26: 1% se înscrie 1.00), iar ieșirile cu valoarea brută care iese, cu minus (exemplele ANAF de imobilizări: rulajul creditor al contului de imobilizare).',
    alternative:
      'Rata se scrie ca fracție (exemplele ANAF: 0.20 pentru cinci ani), iar ieșirile cu valoarea contabilă netă scoasă din evidență (definiția din structură, „book value of the disposals”).',
  },
  question:
    'În declarația D406 pentru active, câmpul DepreciationPercentage se completează în procente (20.00) sau ca fracție (0.20)? Câmpul AssetDisposal cuprinde valoarea brută a mijlocului fix ieșit sau valoarea lui netă? Aplicația mai scrie: amortizarea perioadei și cea cumulată cu minus, „contabil” la MF.A.14 și „CONTABILĂ” la SD.AT.15, metoda „LINIARĂ”, metoda amortizării extraordinare „0”, câte o tranzacție de amortizare pe notă contabilă și, pentru celelalte tranzacții decât achizițiile, compania ca furnizor; conturile listate sunt cele de imobilizări și de amortizare. Sunt corecte?',
  context: [],
  cases: [
    presentationCase(
      'Utilaj deținut tot anul',
      'Valoare 12.000,00 lei, durată 48 de luni, amortizat 3.000,00 lei până în 2026 și 3.000,00 lei în 2026.',
      asset({}),
    ),
    presentationCase(
      'Utilaj vândut la 15 iunie',
      'Același utilaj, amortizat 1.500,00 lei până la vânzare; se scot din evidență valoarea de 12.000,00 lei și amortizarea de 4.500,00 lei.',
      asset({ disposal: '12000.00', depreciation: '1500.00', depreciationRemoved: '4500.00' }),
    ),
    presentationCase(
      'Laptop cumpărat în august, 36 de luni',
      'Valoare 6.000,00 lei, amortizat din septembrie 666,67 lei.',
      asset({
        id: 'MF-2',
        account: '214',
        depreciationAccount: '2814',
        lifeMonths: 37,
        costBegin: '0.00',
        depreciationBegin: '0.00',
        addition: '6000.00',
        depreciation: '666.67',
      }),
    ),
  ],
  gaps: [
    'Documentele ANAF se contrazic: ghidul scrie „NULL” la metoda amortizării extraordinare, răspunsurile „0”, exemplele „NA”; validatorul le primește pe toate.',
    'Imobilizările necorporale (20x) din registru se raportează ca și cele corporale; Catalogul HG nr. 2.139/2004 nu le clasifică.',
  ],
};
