import { divRound, parseMoney, parseScaled } from '../../../money';
import type { ParameterRegister } from '../../../rules';
import type { ReviewCase, ReviewSpec } from '../types';
import { lei, microQuarterTax, microRate, type MicroQuarter } from './world';

/*
 * Readings from ANAF's consolidated Fiscal Code (snapshot ANAF/Cod-fiscal-consolidat):
 * art. 47 alin. (1) lit. c), art. 51 alin. (1), art. 52 alin. (1) and (5), art. 53 and
 * art. 54 alin. (1) and (3); and from OUG nr. 59/2005 art. 1 alin. (1), as the legislative
 * portal consolidates it (snapshot OUG59/2005), for the rounding.
 */

/** A hypothetical BNR rate for 31.12.2025, stated as such in the facts: 100.000 € = 508.000 lei. */
const EUR = '5.0800';
const RATE_NOTE =
  'Cursul EUR de la 31.12.2025 este luat, ipotetic, 5,0800 lei (100.000 € = 508.000,00 lei).';

/** The base rounded to whole lei half up before the rate, then the tax: the alternative. */
function taxWithBaseRounding(register: ParameterRegister, world: MicroQuarter) {
  const rate = microRate(register, world.quarter);
  if (rate instanceof Error) return { summary: 'Blocat: RULE_GAP', lines: [rate.message] };
  const base = Object.entries(world.quarterRevenue).reduce(
    (sum, [, amount]) => sum + parseMoney(amount, 'RON'),
    0n,
  );
  const baseLei = divRound(base, 100n, 'halfAwayFromZero');
  const tax = divRound(baseLei * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero') * 100n;
  return {
    summary: `Calculat: impozit ${lei(tax)} lei pe baza de ${lei(baseLei * 100n)} lei (cota ${rate}%)`,
    lines: [
      `Baza ${lei(base)} lei se rotunjește întâi la leu (${lei(baseLei * 100n)} lei); cota ${rate}% se aplică bazei rotunjite, iar impozitul se rotunjește la leu.`,
    ],
  };
}

function rateCase(title: string, facts: string, world: MicroQuarter): ReviewCase {
  return {
    title,
    facts: `${facts} ${RATE_NOTE}`,
    run: (register) => ({
      engine: microQuarterTax(register, world),
      alternative: taxWithBaseRounding(register, world),
    }),
  };
}

export const microRateSpec: ReviewSpec = {
  key: 'ro.micro.rate',
  kind: 'mechanical',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 8,
  readings: {
    engine:
      'Impozitul trimestrului este 1% din baza impozabilă (art. 51 alin. (1)) pentru trimestrele care încep la sau după 01.01.2026, aplicat bazei în lei și bani; doar impozitul se stabilește la leu, prin reducere sub 50 de bani și prin majorare de la 50 de bani (OUG nr. 59/2005 art. 1 alin. (1), parametrul ro.declaration.rounding).',
    alternative:
      'Baza impozabilă se rotunjește întâi la leu, iar cota de 1% se aplică bazei rotunjite; impozitul rezultat se rotunjește apoi la leu.',
  },
  question:
    'Se aplică cota de 1% bazei impozabile în lei și bani, rotunjind la leu doar impozitul (OUG nr. 59/2005 art. 1 alin. (1)), sau baza se rotunjește întâi la leu?',
  context: ['ANAF/Cod-fiscal-consolidat:art.53', 'OUG59/2005:art.1(1)'],
  cases: [
    rateCase(
      'Trimestrul I 2026, venituri rotunde',
      'Microîntreprindere din 01.01.2026; venituri din servicii (704) de 120.000,00 lei în trimestrul I 2026, fără venituri excluse.',
      {
        quarter: '2026-Q1',
        quarterRevenue: { '704': '120000.00' },
        yearRevenue: { '704': '120000.00' },
        eurRate: EUR,
      },
    ),
    rateCase(
      'Trimestrul II 2026, bani care schimbă rotunjirea',
      'Venituri din servicii de 24.949,60 lei în trimestrul II 2026 (cumulat de la începutul anului: 144.949,60 lei).',
      {
        quarter: '2026-Q2',
        quarterRevenue: { '704': '24949.60' },
        yearRevenue: { '704': '144949.60' },
        eurRate: EUR,
      },
    ),
    rateCase(
      'Trimestrul III 2026, bani care nu schimbă rotunjirea',
      'Venituri din servicii de 30.000,40 lei în trimestrul III 2026 (cumulat: 174.950,00 lei).',
      {
        quarter: '2026-Q3',
        quarterRevenue: { '704': '30000.40' },
        yearRevenue: { '704': '174950.00' },
        eurRate: EUR,
      },
    ),
    rateCase(
      'Trimestrul IV 2025: înainte de versiunea din registru',
      'Microîntreprindere din 2025; venituri de 50.000,00 lei în trimestrul IV 2025. Registrul nu are cotă pentru 2025.',
      {
        quarter: '2025-Q4',
        quarterRevenue: { '704': '50000.00' },
        yearRevenue: { '704': '200000.00' },
        eurRate: EUR,
        microFrom: '2025-01-01',
      },
    ),
  ],
  gaps: [
    'Regula de rotunjire este citită în OUG nr. 59/2005 (măsuri pentru denominarea monedei), art. 1 alin. (1) modificat prin Legea nr. 15/2006, în forma consolidată a portalului legislativ (actualizată până la 26.05.2006, de C.T.C.E.); nu există o copie ANAF sau MF. Codul de procedură fiscală (ediția ANAF din 2019, acum în .sources/) nu are un articol de rotunjire: clauza L207/2015:rounding era greșit localizată și a fost înlocuită.',
    'A doua frază a art. 1 alin. (1) („cu valori mai mici de un leu se întregesc la un leu”) este dată de nota C.T.C.E. ca inaplicabilă după respingerea OUG nr. 181/2005 prin Legea nr. 185/2006. Motorul nu o aplică: un impozit sub 50 de bani devine zero (ZERO_TAX), nu 1 leu.',
    'Data de început 01.01.2026 nu este citită dintr-un text: textul consolidat arată doar forma actuală a art. 51 (alin. (1^1) abrogat), nu și data de la care cota unică de 1% se aplică; actul care a abrogat celelalte cote nu are snapshot înregistrat. Trimestrele de dinainte rămân RULE_GAP.',
  ],
};

type Transfers = NonNullable<MicroQuarter['assetTransfers']>;
const ron = (bani: bigint) => `${bani / 100n}.${String(bani % 100n).padStart(2, '0')}`;
const sumOf = (items: readonly { revenue: string }[]) =>
  items.reduce((sum, item) => sum + parseMoney(item.revenue, 'RON'), 0n);

/** Q2 2026 with the year's turnover (70x) and the quarter's revenue, and the fixed assets the
 * year transferred, as the reviewer states them (`assetTransfers`). */
function limitCase(options: {
  title: string;
  facts: string;
  turnover: string;
  quarter: Record<string, string>;
  transfers?: Transfers;
}): ReviewCase {
  const sales = options.transfers ? sumOf(options.transfers.subgroups) : 0n;
  const world = (transfers: Transfers | undefined): MicroQuarter => ({
    quarter: '2026-Q2',
    quarterRevenue: options.quarter,
    yearRevenue: {
      '704': options.turnover,
      ...(sales ? { '7583': ron(sales) } : {}),
    },
    eurRate: EUR,
    ...(transfers ? { assetTransfers: transfers } : {}),
  });
  // The alternative reads "more than one asset of any subgroup" as any two fixed assets: the
  // same treatment, given the year's assets as if of one subgroup.
  const anySubgroup = (transfers: Transfers | undefined): Transfers | undefined =>
    transfers && transfers.subgroups.length > 1
      ? {
          ...transfers,
          subgroups: [
            {
              subgroup: transfers.subgroups[0]!.subgroup,
              count: transfers.subgroups.reduce((sum, item) => sum + item.count, 0),
              revenue: ron(sumOf(transfers.subgroups)),
            },
          ],
        }
      : transfers;
  return {
    title: options.title,
    facts: `Microîntreprindere din 01.01.2026; trimestrul II 2026. ${options.facts} ${RATE_NOTE}`,
    run: (register) => ({
      engine: microQuarterTax(register, world(options.transfers)),
      alternative: microQuarterTax(register, world(anySubgroup(options.transfers))),
    }),
  };
}

export const microLimitSpec: ReviewSpec = {
  key: 'ro.micro.revenue_limit_eur',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 25,
  readings: {
    engine:
      'În fiecare trimestru, cifra de afaceri cumulată de la începutul anului (conturile 70x, net de 709) se compară cu 100.000 euro la cursul BNR de la închiderea exercițiului precedent; i se adaugă veniturile din transferul mijloacelor fixe când în cursul anului s-a transferat mai mult de un mijloc fix din aceeași subgrupă a Catalogului, și cele din transferul terenurilor când s-a transferat mai mult de un teren (art. 54 alin. (1)). Numai depășirea strictă blochează impozitul micro al trimestrului (din acel trimestru se datorează impozit pe profit).',
    alternative:
      '„Mai mult de un activ din oricare subgrupă” înseamnă oricare două mijloace fixe, indiferent de subgrupă: veniturile din transferul lor se adaugă la cifra de afaceri și când sunt din subgrupe diferite.',
  },
  question:
    'Când adaugă art. 54 alin. (1) veniturile din transferul mijloacelor fixe la cifra de afaceri verificată față de plafonul de 100.000 euro: la mai mult de un mijloc fix din aceeași subgrupă a Catalogului, sau la oricare două mijloace fixe, din orice subgrupe?',
  context: ['ANAF/Cod-fiscal-consolidat:art.54(1)', 'ANAF/Cod-fiscal-consolidat:art.53'],
  cases: [
    limitCase({
      title: 'Sub plafon, fără vânzări de active',
      facts: 'Cifra de afaceri cumulată 450.000,00 lei; venituri în trimestru 120.000,00 lei.',
      turnover: '450000.00',
      quarter: { '704': '120000.00' },
    }),
    limitCase({
      title: 'Două autoturisme din aceeași subgrupă vândute în trimestru',
      facts:
        'Cifra de afaceri cumulată 450.000,00 lei; în trimestru, venituri din servicii 120.000,00 lei și din vânzarea a două autoturisme (subgrupa 2.3) 80.000,00 lei (7583).',
      turnover: '450000.00',
      quarter: { '704': '120000.00', '7583': '80000.00' },
      transfers: { subgroups: [{ subgroup: '2.3', count: 2, revenue: '80000.00' }] },
    }),
    limitCase({
      title: 'Un autoturism și un utilaj, din subgrupe diferite',
      facts:
        'Cifra de afaceri cumulată 450.000,00 lei; în trimestru, venituri din servicii 120.000,00 lei, din vânzarea unui autoturism (subgrupa 2.3) 60.000,00 lei și a unui utilaj (subgrupa 2.1) 20.000,00 lei (7583).',
      turnover: '450000.00',
      quarter: { '704': '120000.00', '7583': '80000.00' },
      transfers: {
        subgroups: [
          { subgroup: '2.3', count: 1, revenue: '60000.00' },
          { subgroup: '2.1', count: 1, revenue: '20000.00' },
        ],
      },
    }),
    limitCase({
      title: 'Un singur autoturism vândut în trimestru',
      facts:
        'Cifra de afaceri cumulată 450.000,00 lei; în trimestru, venituri din servicii 120.000,00 lei și din vânzarea unui singur autoturism (subgrupa 2.3) 80.000,00 lei (7583).',
      turnover: '450000.00',
      quarter: { '704': '120000.00', '7583': '80000.00' },
      transfers: { subgroups: [{ subgroup: '2.3', count: 1, revenue: '80000.00' }] },
    }),
    limitCase({
      title: 'Exact la plafon',
      facts:
        'Cifra de afaceri cumulată 508.000,00 lei, exact 100.000 €; venituri în trimestru 100.000,00 lei.',
      turnover: '508000.00',
      quarter: { '704': '100000.00' },
    }),
  ],
  gaps: [
    'Cursul EUR din cazuri (5,0800 lei) este ipotetic, ales pentru exemplu; nu este cursul BNR de la 31.12.2025, care nu este în .sources/.',
    'Veniturile întreprinderilor legate (art. 47 alin. (1^1), art. 52 alin. (5^1)) nu intră în calculul motorului; niciuna dintre lecturi nu le tratează.',
    'Condiția de intrare (art. 47 alin. (1) lit. c): veniturile anului precedent, la cursul de la închiderea acelui exercițiu) nu este verificată de motor: regimul micro vine din profilul companiei. Normele (titlul III pct. 1 alin. (1)) iau pentru ea veniturile bazei impozabile, iar art. 54 alin. (1) cifra de afaceri.',
    'Transferurile anului (mijloacele fixe pe subgrupe, terenurile și veniturile lor) le declară persoana care aprobă (assetTransfers), cu documentul justificativ, odată ce anul are venituri în 7583: registrul mijloacelor fixe nu reține dacă o scoatere din funcțiune a fost vânzare sau casare. Catalogul (HG nr. 2.139/2004) nu are snapshot înregistrat.',
    '„Respectiv” este citit ca împerechere: veniturile din mijloace fixe se adaugă la mai mult de un mijloc fix, cele din terenuri la mai mult de un teren. O lectură care le adaugă pe toate când una dintre condiții este îndeplinită nu este calculată. Veniturile din vânzarea imobilizărilor necorporale, tot în 7583, nu sunt ale unor mijloace fixe și rămân în afara transferurilor.',
    'Baza impozabilă cuprinde veniturile din vânzarea activelor (7583) în ambele lecturi: art. 53 alin. (1) nu le scade, iar normele (titlul III pct. 5 alin. (1)) pornesc de la toate veniturile din clasa 7.',
  ],
};
