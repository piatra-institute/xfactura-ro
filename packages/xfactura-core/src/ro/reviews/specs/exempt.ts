import { parseMoney } from '../../../money';
import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import {
  definitiveProrata,
  prorataAdjustments,
  shareOf,
  stockVat,
  unusedServiceVat,
  useAdjustment,
  type ProrataRule,
  type StockAdjustmentRule,
} from '../../exempt';
import type { CapitalGoodsRule } from '../../nonpayers/parameters';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { lei } from './world';

/*
 * Readings of exempt supplies, the pro-rata and the adjustments (src/ro/exempt) the texts leave
 * open: where the year-end pro-rata adjustment is booked, where the adjustment of stock and
 * services is booked, and whether the 1.000 lei threshold of the norms still holds for capital
 * goods after art. 305 alin. (9) was repealed. Each case runs the engine's code on fixed figures.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const bani = (text: string) => parseMoney(text, 'RON');
const rulesOf = (register: ParameterRegister) => new RuleContext(register, 'preview');
const withValue = (register: ParameterRegister, key: string, value: unknown) =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );
const parameterLines = (rules: RuleContext) =>
  [...rules.used.keys()].map((id) => `Parametru ${id}`);
const day = (text: string) => text as LocalDate;

// ---------------------------------------------------------------------------------------------
// The year-end pro-rata adjustment (art. 300 alin. (8), (14))

function prorataCase(
  title: string,
  facts: string,
  figures: { withDeduction: string; withoutDeduction: string; vat: string; provisional: number },
): ReviewCase {
  const run = (register: ParameterRegister): CaseOutcome => {
    const rules = rulesOf(register);
    const rule = rules.param<ProrataRule>(
      'ro.vat.prorata',
      'vat_chargeability_date',
      day('2026-12-31'),
    );
    const definitive = definitiveProrata({
      withDeduction: bani(figures.withDeduction),
      withoutDeduction: bani(figures.withoutDeduction),
      subsidies: 0n,
      excluded: 0n,
    });
    if (!definitive)
      return {
        summary: 'Fără livrări: pro rata definitivă nu se calculează',
        lines: parameterLines(rules),
      };
    const vat = bani(figures.vat);
    const deducted = (vat * BigInt(figures.provisional) + 50n) / 100n;
    const [adjustment] = prorataAdjustments(
      [{ code: 'S-21', vatBani: vat, deductedBani: deducted }],
      definitive.percent,
    );
    const amount = adjustment!.bani;
    const booking =
      amount === 0n
        ? 'nimic de înregistrat'
        : amount > 0n
          ? `D 4426 / C ${rule.income} ${lei(amount)} lei`
          : `D ${rule.expense} / C 4426 ${lei(-amount)} lei`;
    return {
      summary: `Pro rata definitivă ${definitive.percent}%: ${booking}`,
      lines: [...definitive.lines, adjustment!.line, ...parameterLines(rules)],
    };
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register),
      alternative: run(
        withValue(register, 'ro.vat.prorata', {
          rounding: 'up_to_unit',
          row: 'R31_2',
          expense: '628',
          income: '628',
        }),
      ),
    }),
  };
}

export const prorataSpec: ReviewSpec = {
  key: 'ro.vat.prorata',
  kind: 'interpretation',
  act: CODE,
  minutes: 20,
  readings: {
    engine:
      'Pro rata definitivă este raportul livrărilor cu drept de deducere la totalul livrărilor anului, rotunjit în sus la procentul întreg (un raport întreg rămâne neschimbat); diferența dintre TVA achizițiilor destinate ambelor feluri de operațiuni la pro rata definitivă și cea dedusă la pro rata provizorie se înregistrează pe 635 (în favoarea bugetului) sau pe 7588 (în favoarea firmei), pe rândul 34 al decontului ultimei perioade a anului, al cărui antet poartă pro rata definitivă.',
    alternative:
      'Diferența corectează cheltuiala în care a intrat taxa nededusă a acelor achiziții (aici 628), în plus sau în minus, nu 635 și 7588.',
  },
  question:
    'Pe ce conturi se înregistrează ajustarea anuală a taxei deduse cu pro rata provizorie la pro rata definitivă (art. 300 alin. (14) din Codul fiscal), și ce pro rata se înscrie în antetul decontului care o cuprinde?',
  context: [`${CODE}:art.300(1)-(7)`, `${CODE}:norme.art.300.pct.70`, 'OPANAF174/2026:rd.31'],
  cases: [
    prorataCase(
      'Pro rata definitivă peste cea provizorie',
      'Firmă cu servicii taxabile de 600.000,00 lei și chirii scutite de 400.000,00 lei în 2026; pro rata provizorie 50%; TVA achizițiilor comune 10.500,00 lei, dedusă 5.250,00 lei.',
      { withDeduction: '600000', withoutDeduction: '400000', vat: '10500', provisional: 50 },
    ),
    prorataCase(
      'Pro rata definitivă sub cea provizorie, rotunjită în sus',
      'Servicii taxabile de 301.000,00 lei și operațiuni scutite de 699.000,00 lei (30,1%); pro rata provizorie 40%; TVA achizițiilor comune 21.000,00 lei.',
      { withDeduction: '301000', withoutDeduction: '699000', vat: '21000', provisional: 40 },
    ),
    prorataCase(
      'Pro rata neschimbată',
      'Servicii taxabile de 500.000,00 lei și scutite de 500.000,00 lei; pro rata provizorie 50%; TVA achizițiilor comune 4.200,00 lei.',
      { withDeduction: '500000', withoutDeduction: '500000', vat: '4200', provisional: 50 },
    ),
  ],
  gaps: [
    'Pro rata specială aprobată sau impusă de Ministerul Finanțelor (art. 300 alin. (16)–(18)), regularizarea anilor fără livrări (alin. (10) lit. d), alin. (13)) și deducerea pe bază de pro rata în sistemul TVA la încasare (norme pct. 79 alin. (18)–(20)) nu sunt calculate.',
    'Rotunjirea pro ratei estimate (alin. (9)) nu este stabilită de text: motorul o înregistrează în procente întregi, ca pe cea definitivă.',
    'Ce operațiuni financiare sau imobiliare sunt accesorii (norme pct. 70 alin. (4)) o hotărăște persoana, cu analiza ei, la ajustarea anului.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The adjustment of stock, services not used and advances (art. 304; norme pct. 78, 83)

function stockCase(
  title: string,
  facts: string,
  item:
    | { kind: 'stock'; value: string; rate: string; event: 'registration' | 'deregistration' }
    | { kind: 'service'; vat: string; value: string; depreciated: string },
): ReviewCase {
  const run = (register: ParameterRegister): CaseOutcome => {
    const rules = rulesOf(register);
    const rule = rules.param<StockAdjustmentRule>(
      'ro.vat.stock_adjustment',
      'vat_chargeability_date',
      day('2026-08-20'),
    );
    const vat =
      item.kind === 'stock'
        ? stockVat({ account: '371', valueBani: bani(item.value), rate: item.rate })
        : unusedServiceVat(bani(item.vat), {
            value: bani(item.value),
            depreciated: bani(item.depreciated),
          });
    const favour = item.kind === 'stock' && item.event === 'registration';
    const booking = favour
      ? `D 4426 / C ${rule.income} ${lei(vat)} lei`
      : `D ${rule.expense} / C 4426 ${lei(vat)} lei`;
    return {
      summary: `Ajustare ${lei(favour ? vat : -vat)} lei: ${booking}, rândul 34`,
      lines: [booking, ...parameterLines(rules)],
    };
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register),
      alternative: run(
        withValue(register, 'ro.vat.stock_adjustment', {
          row: 'R31_2',
          expense: '371',
          income: '371',
        }),
      ),
    }),
  };
}

export const stockAdjustmentSpec: ReviewSpec = {
  key: 'ro.vat.stock_adjustment',
  kind: 'interpretation',
  act: CODE,
  minutes: 15,
  readings: {
    engine:
      'La anularea înregistrării, taxa dedusă pentru stocuri și active în curs (la cota de la achiziție), pentru imobilizările necorporale rămase neamortizate și pentru avansurile nedecontate se anulează pe 635; la înregistrare, taxa nededusă a stocurilor se deduce pe 7588; rândul 34 al decontului; cheltuielile în avans (471) sunt servicii utilizate și nu se ajustează.',
    alternative:
      'Taxa anulată sau dedusă pentru stocuri corectează costul lor (contul de stoc, aici 371), nu 635 și 7588.',
  },
  question:
    'Pe ce conturi se înregistrează ajustarea taxei deduse pentru stocuri, servicii neutilizate și avansuri la schimbarea regimului de TVA (art. 304; norme pct. 78 și pct. 83 alin. (7), (11))?',
  context: [],
  cases: [
    stockCase(
      'Anulare cu marfă în stoc',
      'La anularea înregistrării (20.08.2026) inventarul arată mărfuri de 10.000,00 lei cumpărate cu cota de 21%.',
      { kind: 'stock', value: '10000', rate: '21', event: 'deregistration' },
    ),
    stockCase(
      'Înregistrare cu stoc cumpărat la 19%',
      'La înregistrarea în scopuri de TVA, inventarul arată materiale de 5.000,00 lei cumpărate în iulie 2025, cu cota de 19%, fără deducere.',
      { kind: 'stock', value: '5000', rate: '19', event: 'registration' },
    ),
    stockCase(
      'Program informatic neamortizat',
      'O licență de 12.000,00 lei, cu TVA dedusă de 2.520,00 lei, amortizată 3.000,00 lei la anularea înregistrării.',
      { kind: 'service', vat: '2520', value: '12000', depreciated: '3000' },
    ),
  ],
  gaps: [
    'Stocurile ținute la preț de vânzare (378, 4428), cu diferențe de preț (308, 348, 368, 388) sau cu ajustări pentru depreciere (39x) nu se ajustează automat: vat.capitalGoods le refuză.',
    'Cota fiecărei linii de inventar este cea declarată de persoană, cu inventarul: registrele nu leagă stocurile de facturile lor.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The smallest adjustment of a capital good (art. 305 alin. (9), repealed; norme pct. 79 alin. (4))

function minimumCase(
  title: string,
  facts: string,
  good: { vat: string; deducted: string; acquiredOn: string; share: string; year: number },
): ReviewCase {
  const run = (register: ParameterRegister): CaseOutcome => {
    const rules = rulesOf(register);
    const date = day(`${good.year}-12-31`);
    const rule = rules.param<CapitalGoodsRule>(
      'ro.vat.capital_goods',
      'vat_chargeability_date',
      date,
    );
    const minimum = rules.param<string>(
      'ro.vat.capital_goods.minimum',
      'vat_chargeability_date',
      date,
    );
    const adjustment = useAdjustment(
      {
        assetId: 'a1',
        number: 'MF-1',
        name: 'Echipament',
        immovable: false,
        acquiredOn: day(good.acquiredOn),
        vatBani: bani(good.vat),
        deductedBani: bani(good.deducted),
      },
      good.year,
      shareOf(good.share)!,
      0n,
      rule,
    );
    const absolute = adjustment.bani < 0n ? -adjustment.bani : adjustment.bani;
    const made = absolute >= BigInt(minimum) * 100n;
    return {
      summary: made
        ? `Ajustare ${lei(adjustment.bani)} lei, înregistrată`
        : `Ajustare ${lei(adjustment.bani)} lei sub ${minimum} lei: nu se înregistrează`,
      lines: [adjustment.line, ...parameterLines(rules)],
    };
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register),
      alternative: run(withValue(register, 'ro.vat.capital_goods.minimum', '1000')),
    }),
  };
}

export const capitalMinimumSpec: ReviewSpec = {
  key: 'ro.vat.capital_goods.minimum',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'Art. 305 alin. (9) este abrogat de la 01.07.2024 (OUG nr. 78/2024 art. I pct. 3 lit. A): pragul de 1.000 lei pe care normele îl dau „în sensul art. 305 alin. (9)” (pct. 79 alin. (4)) nu mai are temei, deci orice ajustare a unui bun de capital se înregistrează.',
    alternative:
      'Pragul normelor se aplică în continuare: o ajustare a unui bun de capital mai mică de 1.000 lei nu se înregistrează.',
  },
  question:
    'După abrogarea art. 305 alin. (9) din Codul fiscal (OUG nr. 78/2024), se mai aplică pragul de 1.000 lei sub care normele metodologice (pct. 79 alin. (4)) spun că ajustarea unui bun de capital nu se efectuează?',
  context: [`${CODE}:art.305(4)-(5),(7)`],
  cases: [
    minimumCase(
      'Echipament folosit o parte din an scutit',
      'Echipament cumpărat în martie 2025 cu TVA dedusă de 20.000,00 lei; din 2026 folosit 80% pentru operațiuni cu drept de deducere.',
      { vat: '20000', deducted: '20000', acquiredOn: '2025-03-10', share: '80', year: 2026 },
    ),
    minimumCase(
      'Ajustare de 800 lei',
      'Echipament cumpărat în 2025 cu TVA dedusă de 4.000,00 lei; din 2026 folosit doar pentru operațiuni scutite.',
      { vat: '4000', deducted: '4000', acquiredOn: '2025-05-02', share: '0', year: 2026 },
    ),
    minimumCase(
      'Bun nededus trecut la operațiuni taxabile',
      'Utilaj cumpărat în 2024 cu TVA de 3.000,00 lei, nededusă (folosit pentru operațiuni scutite); din 2026 folosit integral pentru operațiuni taxabile.',
      { vat: '3000', deducted: '0', acquiredOn: '2024-06-15', share: '100', year: 2026 },
    ),
  ],
  gaps: [
    'Textul alin. (9) dinainte de abrogare nu este în copiile citite: nota de abrogare a portalului legislativ arată doar actul și data.',
  ],
};
