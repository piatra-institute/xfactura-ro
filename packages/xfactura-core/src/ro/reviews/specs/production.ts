import type {
  AccountTurnover,
  Evaluation,
  Loaded,
  PayrollRunState,
  ProductionLine,
  ProfileFact,
  WorkOrderRecord,
} from '../../../kernel';
import { stockPositionKey, turnoverKey } from '../../../kernel';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import {
  costInput,
  differencesInput,
  orderTag,
  differencesTag,
  productionCost,
  productionDifferences,
} from '../../production/treatments';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of production (src/ro/production) the texts leave open: whether direct labour costs
 * the employer's contributions on the salary too (pct. 8 pct. 7 names "manoperă directă"), how
 * the work in progress of a job order is valued (pct. 288: by the count, at the production costs),
 * and over which period the products' price differences are spread (pct. 286 alin. (4)). Each case
 * runs the engine's treatment on fixed figures: a joinery making tables.
 */

const OMFPA = 'OMFP1802/2014-A';
const FROM = '2026-03-01' as LocalDate;
const END = '2026-03-31' as LocalDate;
const TABLE = '00000000-0000-4000-8000-00000000d001';
const BOARD = '00000000-0000-4000-8000-00000000d002';
const PROGRESS = '00000000-0000-4000-8000-00000000d003';
const DEPOT = '00000000-0000-4000-8000-00000000d004';
const SHOP = '00000000-0000-4000-8000-00000000d005';
const BOM = '00000000-0000-4000-8000-00000000d006';
const ORDER = '00000000-0000-4000-8000-00000000d007';
const RUN = '00000000-0000-4000-8000-00000000d008';
const CONTRACT = '00000000-0000-4000-8000-00000000d009';
const EVIDENCE = '00000000-0000-4000-8000-00000000d00a';

const withValue = (register: ParameterRegister, key: string, value: unknown) =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );
const valueOf = (register: ParameterRegister, key: string) =>
  register.versions.find((version) => version.key === key)!.value as Record<string, unknown>;

function outcome(
  evaluation: Evaluation,
  register: ParameterRegister,
  rules: RuleContext,
): CaseOutcome {
  const parameters = [...rules.used.keys()].map((id) => {
    const version = register.versions.find((item) => item.id === id);
    return `Parametru ${id} = ${JSON.stringify(version?.value)}`;
  });
  const issues = evaluation.issues.map(
    (issue) =>
      `${issue.severity === 'block' ? 'Blocare' : issue.severity === 'ack' ? 'De confirmat' : 'Informare'} ${issue.code}: ${issue.message}`,
  );
  if (!evaluation.effect)
    return {
      summary: `Blocat: ${[...new Set(evaluation.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code))].join(', ')}`,
      lines: [...issues, ...parameters],
    };
  const lines = evaluation.effect.lines.map(
    (line) => `${line.side} ${line.account} ${lei(line.bani)} lei`,
  );
  return {
    summary: lines.length ? `Propus: ${lines.join('; ')}` : 'Propus: fără înregistrări',
    lines: [...issues, ...parameters],
  };
}

function run(register: ParameterRegister, evaluate: (rules: RuleContext) => Evaluation) {
  const rules = new RuleContext(register, 'preview');
  try {
    return outcome(evaluate(rules), register, rules);
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
}

const facts: ProfileFact[] = [
  ['vat.status', 'normal_vat'],
  ['policy.stock.valuation', 'fifo'],
  ['policy.stock.inventory', 'permanent'],
  ['policy.stock.negative', 'refuse'],
  ['policy.production.cost', 'standard'],
].map(([axis, value]) => ({
  axis: axis!,
  value: value!,
  effectiveFrom: '2026-01-01' as LocalDate,
}));

const tagged = (
  account: string,
  date: string,
  debit: bigint,
  credit: bigint,
  item: string | null = null,
  quantity = 0n,
  tag = orderTag(ORDER),
): ProductionLine => ({
  tag,
  account,
  date: date as LocalDate,
  debit,
  credit,
  item,
  quantity,
});

/** The joinery: a table (345) made of boards (301) on a bill of materials of 2 boards a table at
 * a standard cost of 300,00 lei, its work in progress on 331, one order and its lines. */
function joinery(options: {
  lines: ProductionLine[];
  closedOn?: string;
  run?: PayrollRunState;
  turnover?: [string, AccountTurnover[]][];
}): Loaded {
  const order: WorkOrderRecord = {
    id: ORDER,
    number: 'CP-1',
    itemId: TABLE,
    bomId: BOM,
    quantity: 10_000n,
    openedOn: '2026-01-05' as LocalDate,
    closedOn: (options.closedOn as LocalDate | undefined) ?? null,
    evidenceId: EVIDENCE,
  };
  const item = (id: string, code: string, name: string, account: string) =>
    [id, { id, code, name, unit: 'H87', nc8: null, account, vatCategory: 'standard' }] as const;
  return {
    ...emptyLoaded(facts),
    years: [
      {
        id: 'fy-2026',
        kind: 'financial',
        from: '2026-01-01' as LocalDate,
        to: '2026-12-31' as LocalDate,
      },
    ],
    evidence: new Map([
      [EVIDENCE, { id: EVIDENCE, hash: 'h', filename: 'pontaj.pdf', mediaType: 'application/pdf' }],
    ]),
    payrollRuns: new Map(options.run ? [[RUN, options.run]] : []),
    turnover: new Map(options.turnover ?? []),
    stock: new Map([
      [stockPositionKey(PROGRESS, SHOP), { item: PROGRESS, warehouse: SHOP, moves: 0, layers: [] }],
    ]),
    stockItems: new Map([
      item(TABLE, 'MASA-1', 'Masă', '345'),
      item(BOARD, 'PAL-18', 'Placă PAL', '301'),
      item(PROGRESS, 'PIC-MASA', 'Mese în curs', '331'),
    ]),
    warehouses: new Map([
      [DEPOT, { id: DEPOT, code: 'D1', name: 'Depozit', keeper: 'Ionescu Maria' }],
      [SHOP, { id: SHOP, code: 'S1', name: 'Atelier', keeper: 'Pop Ion' }],
    ]),
    production: {
      boms: new Map([
        [
          BOM,
          {
            id: BOM,
            itemId: TABLE,
            version: 1,
            validFrom: '2026-01-01' as LocalDate,
            outputQuantity: 1_000n,
            standardCost: 30_000n,
            labourHours: 8_000n,
            machineHours: null,
            evidenceId: EVIDENCE,
            lines: [{ lineNo: 1, itemId: BOARD, quantity: 2_000n }],
          },
        ],
      ]),
      orders: new Map([[ORDER, order]]),
      lines: options.lines,
    },
  };
}

/** Materials of the month for `boards` boards of 100,00 lei given to the order. */
const materials = (boards: bigint) => [
  tagged('601', '2026-03-10', boards * 10_000n, 0n),
  tagged('301', '2026-03-10', 0n, boards * 10_000n, BOARD, -boards * 1_000n),
];
/** Tables handed over in the month at their standard cost. */
const handedOver = (tables: bigint) => [
  tagged('345', '2026-03-20', tables * 30_000n, 0n, TABLE, tables * 1_000n),
  tagged('711', '2026-03-20', 0n, tables * 30_000n),
];

const payroll: PayrollRunState = {
  id: RUN,
  month: '2026-03',
  round: 1,
  state: 'prepared',
  issues: 0,
  corrects: null,
  lines: [
    {
      contractId: CONTRACT,
      employeeId: CONTRACT,
      partyId: CONTRACT,
      cash: 500_000n,
      vouchers: 0n,
      cas: 125_000n,
      cass: 50_000n,
      casEmployer: 0n,
      cassEmployer: 0n,
      tax: 32_500n,
      unionDues: 0n,
      net: 292_500n,
      cam: 11_250n,
      camBase: 500_000n,
      sickFund: 0n,
      inKind: 0n,
      garnishments: [],
    },
  ],
};
const labourTurnover: [string, AccountTurnover[]] = [
  turnoverKey({ prefixes: ['64'], from: FROM, to: END }),
  [
    { account: '641', debit: 500_000n, credit: 0n },
    { account: '646', debit: 11_250n, credit: 0n },
  ],
];

// ---------------------------------------------------------------------------------------------
// Direct labour's cost (pct. 8 pct. 7)

function labourCase(
  title: string,
  facts_: string,
  labour: Record<string, unknown>,
  lines: ProductionLine[],
  closedOn?: string,
): ReviewCase {
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) =>
      productionCost.evaluate(
        costInput.parse({
          month: '2026-03',
          labour,
          overheads: [],
          ...(closedOn
            ? {}
            : {
                wip: {
                  evidenceId: EVIDENCE,
                  orders: [{ orderId: ORDER, itemId: PROGRESS, warehouseId: SHOP, quantity: '1' }],
                },
              }),
        }),
        joinery({
          lines,
          ...(closedOn ? { closedOn } : {}),
          run: payroll,
          turnover: [labourTurnover],
        }),
        rules,
      ),
    );
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.production.accounts', {
          ...valueOf(register, 'ro.production.accounts'),
          labour: { salary: '641', contributions: [] },
        }),
      ),
    }),
  };
}

const byHours = (onOrder: string) => ({
  method: 'hours',
  runId: RUN,
  evidenceId: EVIDENCE,
  contracts: [{ contractId: CONTRACT, hours: '160', orders: [{ orderId: ORDER, hours: onOrder }] }],
});

export const productionAccountsSpec: ReviewSpec = {
  key: 'ro.production.accounts',
  kind: 'interpretation',
  act: OMFPA,
  minutes: 15,
  readings: {
    engine:
      'Manopera directă a unei comenzi cuprinde salariul brut (641) și contribuția asiguratorie pentru muncă datorată de angajator pe el (646), cu contribuțiile suportate în numele salariatului, după orele lucrate pe comandă.',
    alternative:
      'Manopera directă este doar salariul (641); contribuțiile angajatorului rămân cheltuieli ale perioadei, în afara costului de producție.',
  },
  question:
    'Costul de producție cuprinde „manoperă directă” (OMFP nr. 1.802/2014 pct. 8 pct. 7): intră în el și contribuția asiguratorie pentru muncă (646) pe salariile personalului direct productiv, sau doar salariile (641)?',
  context: [`${OMFPA}:pct.79`],
  cases: [
    labourCase(
      'Comandă deschisă, jumătate din ore',
      'Martie: un tâmplar cu salariul de 5.000 lei (CAM 112,50 lei) lucrează 80 din 160 de ore la comanda CP-1, care a primit 2 plăci PAL (200 lei); comanda rămâne deschisă, o masă în curs.',
      byHours('80'),
      materials(2n),
    ),
    labourCase(
      'Toate orele pe comandă',
      'Martie: tâmplarul lucrează toate cele 160 de ore la CP-1, care a primit 2 plăci (200 lei) și rămâne deschisă.',
      byHours('160'),
      materials(2n),
    ),
    labourCase(
      'Cheie declarată',
      'Martie: administratorul declară că 50% din manopera lunii (641 și 646) privește CP-1, deschisă, cu 2 plăci (200 lei).',
      { method: 'stated', evidenceId: EVIDENCE, orders: [{ orderId: ORDER, percent: '50' }] },
      materials(2n),
    ),
    labourCase(
      'Comandă închisă la cost standard',
      'Martie: CP-1 primește 20 de plăci (2.000 lei), tâmplarul lucrează 80 din 160 de ore la ea, predă 10 mese la costul standard de 300 lei (3.000 lei) și se închide la 31 martie.',
      byHours('80'),
      [...materials(20n), ...handedOver(10n)],
      '2026-03-31',
    ),
  ],
  gaps: [
    'Manopera indirectă (maiștri, întreținere) ca regie fixă nu este construită: se repartizează doar prin cheia declarată.',
    'Costurile îndatorării activelor cu ciclu lung de fabricație (pct. 80) nu sunt construite.',
    'Clasa 9 nu se folosește (pct. 593 alin. (4)): fișa de calculație se ține în afara conturilor.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The work in progress of a job order (pct. 288)

function wipCase(
  title: string,
  facts_: string,
  lines: ProductionLine[],
  counted: { quantity: string; completion: string },
): ReviewCase {
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) =>
      productionCost.evaluate(
        costInput.parse({
          month: '2026-03',
          labour: { method: 'none' },
          overheads: [],
          wip: {
            evidenceId: EVIDENCE,
            orders: [
              {
                orderId: ORDER,
                itemId: PROGRESS,
                warehouseId: SHOP,
                quantity: counted.quantity,
                completion: counted.completion,
              },
            ],
          },
        }),
        joinery({ lines }),
        rules,
      ),
    );
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.production.costing', {
          ...valueOf(register, 'ro.production.costing'),
          wip: 'completion',
        }),
      ),
    }),
  };
}

export const productionCostingSpec: ReviewSpec = {
  key: 'ro.production.costing',
  kind: 'interpretation',
  act: OMFPA,
  minutes: 15,
  readings: {
    engine:
      'Producția în curs a unei comenzi deschise la sfârșitul lunii este costul ei acumulat (materiale, manoperă, regie), mai puțin produsele predate la preț de înregistrare; inventarul confirmă comenzile și unitățile în curs.',
    alternative:
      'Producția în curs se evaluează din inventar: unitățile în curs înmulțite cu gradul lor de finalizare și cu costul standard unitar; diferența față de costul acumulat rămâne cheltuială.',
  },
  question:
    'Pentru o comandă de producție neterminată la sfârșitul perioadei (OMFP nr. 1.802/2014 pct. 288: inventarierea producției neterminate, gradul de finalizare, evaluarea la costurile de producție), producția în curs este costul acumulat al comenzii, mai puțin produsele predate, sau unitățile inventariate după gradul de finalizare la costul standard?',
  context: [`${OMFPA}:conturi.331-332`, `${OMFPA}:conturi.711-712`],
  cases: [
    wipCase(
      'Comandă fără predări',
      'Martie: CP-1 a primit 2 plăci (200 lei); inventarul găsește o masă în curs, terminată 50%; costul standard al mesei este 300 lei.',
      materials(2n),
      { quantity: '1', completion: '50' },
    ),
    wipCase(
      'Comandă cu predări parțiale',
      'Martie: CP-1 a primit 15 plăci (1.500 lei) și a predat 3 mese la 300 lei (900 lei); inventarul găsește 2 mese în curs, terminate 60%.',
      [...materials(15n), ...handedOver(3n)],
      { quantity: '2', completion: '60' },
    ),
    wipCase(
      'Cost acumulat sub standard',
      'Martie: CP-1 a primit o placă (100 lei); inventarul găsește o masă în curs, terminată 80%.',
      materials(1n),
      { quantity: '1', completion: '80' },
    ),
  ],
  gaps: [
    'Gradul de finalizare se declară în lista de inventariere; aplicația nu îl verifică.',
    'Producția în curs preluată la începutul folosirii aplicației (fără comenzile ei) nu este construită.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The price differences' coefficient (pct. 286 alin. (4))

function coefficientCase(
  title: string,
  facts_: string,
  lines: ProductionLine[],
  turnover: {
    beforeYear: AccountTurnover[];
    inYear: AccountTurnover[];
    beforeMonth: AccountTurnover[];
    inMonth: AccountTurnover[];
  },
): ReviewCase {
  const always = '1900-01-01' as LocalDate;
  const key = (from: LocalDate, to: LocalDate) =>
    turnoverKey({ prefixes: ['34'], from, to, sides: 'original' });
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) =>
      productionDifferences.evaluate(
        differencesInput.parse({ month: '2026-03' }),
        joinery({
          lines,
          closedOn: '2026-03-31',
          turnover: [
            [key(always, '2025-12-31' as LocalDate), turnover.beforeYear],
            [key('2026-01-01' as LocalDate, END), turnover.inYear],
            [key(always, '2026-02-28' as LocalDate), turnover.beforeMonth],
            [key(FROM, END), turnover.inMonth],
          ],
        }),
        rules,
      ),
    );
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(withValue(register, 'ro.production.coefficient', { basis: 'month' })),
    }),
  };
}

const finished = (debit: bigint, credit: bigint): AccountTurnover[] =>
  debit || credit ? [{ account: '345', debit, credit }] : [];

export const productionCoefficientSpec: ReviewSpec = {
  key: 'ro.production.coefficient',
  kind: 'interpretation',
  act: OMFPA,
  minutes: 10,
  readings: {
    engine:
      'Coeficientul se calculează cumulat de la începutul exercițiului: soldul inițial al diferențelor și diferențele intrărilor anului, raportate la soldul inițial și intrările anului la preț de înregistrare, aplicat ieșirilor cumulate, mai puțin ce au preluat lunile anterioare.',
    alternative:
      'Coeficientul se calculează pe lună: soldul diferențelor de la începutul lunii și diferențele lunii, raportate la stocul de la începutul lunii și intrările lunii, aplicat ieșirilor lunii.',
  },
  question:
    'Coeficientul de repartizare a diferențelor de preț la produse (OMFP nr. 1.802/2014 pct. 286 alin. (4)) se aplică ieșirilor cumulate de la începutul exercițiului (scăzând ce s-a repartizat în lunile anterioare) sau se calculează și se aplică pe fiecare lună?',
  context: [`${OMFPA}:pct.286(1)-(3)`],
  cases: [
    coefficientCase(
      'Prima lună cu producție',
      'Martie: CP-1 predă 10 mese la standard (3.000 lei) cu o diferență nefavorabilă de 300 lei; se vând 6 mese (1.800 lei la standard).',
      [tagged('348', '2026-03-31', 30_000n, 0n)],
      {
        beforeYear: [],
        inYear: finished(300_000n, 180_000n),
        beforeMonth: [],
        inMonth: finished(300_000n, 180_000n),
      },
    ),
    coefficientCase(
      'Diferențe din ianuarie',
      'Ianuarie: intrări 3.000 lei, diferență nefavorabilă 600 lei, ieșiri 1.500 lei (300 lei repartizați). Martie: intrări 3.000 lei fără diferențe, ieșiri 3.000 lei.',
      [
        tagged('348', '2026-01-31', 60_000n, 0n),
        tagged('348', '2026-01-31', 0n, 30_000n, null, 0n, differencesTag('345')),
      ],
      {
        beforeYear: [],
        inYear: finished(600_000n, 450_000n),
        beforeMonth: finished(300_000n, 150_000n),
        inMonth: finished(300_000n, 300_000n),
      },
    ),
    coefficientCase(
      'Diferență favorabilă',
      'Martie: intrări 3.000 lei la standard cu o diferență favorabilă de 300 lei (costul efectiv 2.700 lei); ieșiri 1.500 lei.',
      [tagged('348', '2026-03-31', 0n, 30_000n)],
      {
        beforeYear: [],
        inYear: finished(300_000n, 150_000n),
        beforeMonth: [],
        inMonth: finished(300_000n, 150_000n),
      },
    ),
  ],
  gaps: [
    'Coeficientul se calculează pe contul sintetic de produse (341, 345); grupele sau categoriile de stocuri (pct. 286 alin. (5)) nu sunt construite.',
    'O schimbare a metodei de cost în cursul exercițiului nu este acoperită.',
  ],
};
