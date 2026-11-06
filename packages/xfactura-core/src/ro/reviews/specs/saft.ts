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
import {
  d406InvoiceTaxBase,
  d406LineParts,
  type D406ConversionReading,
  type D406Currency,
} from '../../saft/d406';
import type { D406Start } from '../../saft/parameters';
import { divRound, formatScaled, parseScaled } from '../../../money';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';

/*
 * Readings of D406 (src/ro/saft) the texts leave open: when the annual assets file is due and in
 * what order, from when a taxpayer category files, how the assets file writes the fields ANAF's
 * documents disagree on, and how the periodic file writes amounts in a currency. Every outcome is
 * computed by the engine's own functions against the register under review.
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

// ---------------------------------------------------------------------------------------------
// How the periodic file writes amounts in a currency (S.AM.1–S.AM.4, S.TI.4)

const leiText = (cents: bigint) => formatScaled(cents, 2).replace('.', ',');
const flipped = (reading: D406ConversionReading): D406ConversionReading => ({
  unrated: reading.unrated === 'split' ? 'lei' : 'split',
  taxBase: reading.taxBase === 'tax' ? 'line' : 'tax',
});
const conversionOf = (register: ParameterRegister) =>
  rules(register).param<D406ConversionReading>(
    'ro.d406.conversion',
    'reporting_period_start',
    '2026-03-01' as LocalDate,
  );

/** A partner's line of the ledger in a currency, as the file writes it by the reading. */
function lineCase(
  title: string,
  facts: string,
  line: { account: string; amount: string; currency: D406Currency; recorded: string },
): ReviewCase {
  const outcome = (reading: D406ConversionReading): CaseOutcome => {
    const parts = d406LineParts(reading, line.amount, line.currency, line.recorded);
    const shown = parts.map((part) =>
      part.currency
        ? `${line.account}: ${leiText(parseScaled(part.amount, 2))} lei = ${part.currency.amount.replace('.', ',')} ${part.currency.code} × ${part.currency.rate.replace('.', ',')}`
        : `${line.account}: ${leiText(parseScaled(part.amount, 2))} lei, în lei (RON)`,
    );
    return { summary: shown.join('; '), lines: shown };
  };
  return {
    title,
    facts,
    run(register) {
      try {
        const reading = conversionOf(register);
        return { engine: outcome(reading), alternative: outcome(flipped(reading)) };
      } catch (error) {
        const result = blocked(error);
        return { engine: result, alternative: result };
      }
    },
  };
}

/** An invoice line in a currency: its TaxBase by the reading, against ANAF's consistency tests
 * (the rate applied to the base gives the VAT, within a ban). */
function baseCase(
  title: string,
  facts: string,
  amounts: { line: string; tax: string; vat: string; rate: number },
): ReviewCase {
  const outcome = (reading: D406ConversionReading): CaseOutcome => {
    const base = d406InvoiceTaxBase(reading, {
      line: parseScaled(amounts.line, 2),
      tax: parseScaled(amounts.tax, 2),
    });
    const expected = divRound(base * BigInt(amounts.rate * 100), 10000n, 'halfAwayFromZero');
    const vat = parseScaled(amounts.vat, 2);
    const off = vat > expected ? vat - expected : expected - vat;
    return {
      summary: `TaxBase ${leiText(base)} lei, TaxAmount ${leiText(vat)} lei: ${amounts.rate}% din bază este ${leiText(expected)}${off > 1n ? `, diferă cu ${leiText(off)}` : ''}`,
      lines: [`InvoiceLineAmount ${leiText(parseScaled(amounts.line, 2))} lei`],
    };
  };
  return {
    title,
    facts,
    run(register) {
      try {
        const reading = conversionOf(register);
        return { engine: outcome(reading), alternative: outcome(flipped(reading)) };
      } catch (error) {
        const result = blocked(error);
        return { engine: result, alternative: result };
      }
    },
  };
}

export const d406ConversionSpec: ReviewSpec = {
  key: 'ro.d406.conversion',
  kind: 'interpretation',
  act: 'ANAF/D406',
  minutes: 20,
  readings: {
    engine:
      'O linie în valută ale cărei sume în lei nu sunt suma în valută la niciun curs cu patru zecimale (o creanță cu venitul și TVA la cursuri diferite, stinsă proporțional) se scrie în două: suma în valută la cursul la care s-a înregistrat creanța și diferența în lei, fiecare cu CurrencyAmount x ExchangeRate = Amount (S.AM.4); baza TVA a unei linii de factură în valută este baza în lei la cursul taxei, al exigibilității sau, la o ajustare, al operațiunii de bază (nota la S.AM.4, S.TI.4).',
    alternative:
      'Linia se scrie întreagă, numai în lei (CurrencyCode RON), cum se scrie principalul unui leasing stins la valoarea contabilă, iar baza TVA a liniei de factură este suma ei în lei la cursul facturii (InvoiceLineAmount).',
  },
  question:
    'În D406 lunar sau trimestrial, o linie pe contul unui client în valută care stinge proporțional o creanță înregistrată la două cursuri (venitul la cursul facturii, TVA la cursul livrării) se scrie în două linii, partea în valută la cursul creanței și diferența în lei, sau o singură linie în lei? Baza TVA (TaxBase) a unei linii de factură în valută este baza la cursul taxei (al exigibilității; la o notă de credit, al facturii inițiale) sau suma liniei la cursul facturii?',
  context: [],
  cases: [
    lineCase(
      'Încasare parțială a unei creanțe fără un singur curs',
      'EXP-M din 20.03.2026, pentru o livrare din 10.03: 1.000,00 EUR venit la 4,9850 și 210,00 EUR TVA la 4,9765, creanța 6.030,07 lei pentru 1.210,00 EUR; se încasează 605,00 EUR la 31.03, la 4,9900, înaintea reevaluării: creanța scade proporțional cu 3.015,04 lei.',
      {
        account: '4111',
        amount: '3015.04',
        currency: { code: 'EUR', amount: '605.00', rate: '4.9900' },
        recorded: '4.9850',
      },
    ),
    lineCase(
      'Nota de credit pe aceeași creanță',
      'CN-M1 din 31.03 creditează 100,00 + 21,00 EUR din EXP-M, la 4,9900: creanța scade proporțional cu 603,01 lei, prin stornare în roșu.',
      {
        account: '4111',
        amount: '-603.01',
        currency: { code: 'EUR', amount: '-121.00', rate: '4.9900' },
        recorded: '4.9850',
      },
    ),
    lineCase(
      'O creanță la un singur curs',
      'EXP-1 din 10.03.2026, 1.210,00 EUR la 4,9765: creanța 6.021,57 lei, stinsă la cursul ei.',
      {
        account: '4111',
        amount: '6021.57',
        currency: { code: 'EUR', amount: '1210.00', rate: '4.9765' },
        recorded: '4.9765',
      },
    ),
    baseCase(
      'Nota de credit în euro: TVA la cursul facturii',
      'CN-2 din 08.04.2026 creditează 200,00 + 42,00 EUR din EXP-1 (10.03, 4,9765); venitul la cursul notei, 5,0100: −1.002,00 lei; baza TVA la cursul facturii, −995,30 lei, TVA −209,01 lei (art. 282 alin. (9) din Codul fiscal).',
      { line: '-1002.00', tax: '-995.30', vat: '-209.01', rate: 21 },
    ),
    baseCase(
      'Factură în euro cu livrarea înaintea emiterii',
      'V-EU din 02.04.2026 pentru o livrare din 27.03: 1.000,00 EUR, venitul la 4,9900 (4.990,00 lei), baza TVA la 4,9800 (4.980,00 lei), TVA 1.045,80 lei (art. 290).',
      { line: '4990.00', tax: '4980.00', vat: '1045.80', rate: 21 },
    ),
  ],
  gaps: [
    'Validatorul ANAF nu verifică conversia (S.AM.1) și primește ambele lecturi; testele de consistență ANAF (cota aplicată bazei dă TVA) citesc baza.',
    'Cursul părții în valută este cel al liniei prin care creanța s-a înregistrat; un ghid ANAF care să descrie stingerea unei creanțe fără un singur curs nu a fost găsit.',
  ],
};
