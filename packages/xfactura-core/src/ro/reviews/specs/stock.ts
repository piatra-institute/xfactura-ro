import type {
  DocumentRecord,
  Evaluation,
  Loaded,
  ProfileFact,
  StockLayerState,
} from '../../../kernel';
import { stockPositionKey } from '../../../kernel';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { stockCount, stockCountInput } from '../../stock/inventory';
import { periodCostInput, stockPeriodCost } from '../../stock/treatments';
import { reversal, reversalInput } from '../../treatments/ledger';
import { inventoryListSchema } from '../../yearend/documents';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of the stock register (src/ro/stock) the texts leave open: where a surplus found at a
 * count is credited (the stock account's expense, as the functions of 371, 30x and 381 pair it,
 * or another operating revenue), and over which period the periodic weighted average is computed
 * (pct. 96 alin. (2) bounds it by the average storage time, which the engine does not know). Each
 * case runs the engine's treatment on fixed figures.
 */

const OMFP = 'OMFP1802/2014';
const DATE = '2026-12-31' as LocalDate;
const LIST = '00000000-0000-4000-8000-00000000c001';
const DECISION = '00000000-0000-4000-8000-00000000c002';
const COFFEE = '00000000-0000-4000-8000-00000000c003';
const PAPER = '00000000-0000-4000-8000-00000000c004';
const DEPOT = '00000000-0000-4000-8000-00000000c005';
const ORIGIN = '00000000-0000-4000-8000-00000000c006';

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
  return { summary: `Propus: ${lines.join('; ')}`, lines: [...issues, ...parameters] };
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

const facts = (method: string): ProfileFact[] =>
  [
    ['vat.status', 'normal_vat'],
    ['vat.period', 'monthly'],
    ['policy.stock.valuation', method],
    ['policy.stock.inventory', 'permanent'],
    ['policy.stock.negative', 'refuse'],
  ].map(([axis, value]) => ({
    axis: axis!,
    value: value!,
    effectiveFrom: '2026-01-01' as LocalDate,
  }));

const layer = (
  id: string,
  item: string,
  account: string,
  method: StockLayerState['method'],
  quantity: bigint,
  bani: bigint,
  flows?: StockLayerState['flows'],
): StockLayerState => ({
  id,
  item,
  warehouse: DEPOT,
  account,
  method,
  mayGoNegative: false,
  quantity,
  bani,
  date: '2026-03-02' as LocalDate,
  originEntryId: ORIGIN,
  seq: 1,
  ...(flows ? { flows } : {}),
});

/** A shop's register: coffee (371) and paper (3028) in its depot, as the layers given. */
function shop(method: string, layers: StockLayerState[], documents: DocumentRecord[] = []): Loaded {
  const loaded = emptyLoaded(facts(method));
  const positions = new Map<string, StockLayerState[]>();
  for (const row of layers)
    positions.set(stockPositionKey(row.item, row.warehouse), [
      ...(positions.get(stockPositionKey(row.item, row.warehouse)) ?? []),
      row,
    ]);
  return {
    ...loaded,
    years: [{ id: 'fy-2026', kind: 'financial', from: '2026-01-01' as LocalDate, to: DATE }],
    evidence: new Map([
      [
        DECISION,
        { id: DECISION, hash: 'h', filename: 'decizie.pdf', mediaType: 'application/pdf' },
      ],
    ]),
    documents: new Map(documents.map((document) => [document.id, document])),
    stock: new Map(
      [...positions].map(([key, rows]) => [
        key,
        { item: rows[0]!.item, warehouse: DEPOT, moves: rows.length, layers: rows },
      ]),
    ),
    stockItems: new Map([
      [
        COFFEE,
        {
          id: COFFEE,
          code: 'CAF-1',
          name: 'Cafea',
          unit: 'H87',
          nc8: null,
          account: '371',
          vatCategory: 'standard',
        },
      ],
      [
        PAPER,
        {
          id: PAPER,
          code: 'HRT-1',
          name: 'Hârtie',
          unit: 'XBX',
          nc8: null,
          account: '3028',
          vatCategory: 'standard',
        },
      ],
    ]),
    warehouses: new Map([
      [DEPOT, { id: DEPOT, code: 'D1', name: 'Depozit', keeper: 'Ionescu Maria' }],
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// A surplus at the count (the functions of 371, 30x, 381; OMFP 1802/2014 pct. 75 alin. (1))

function countCase(
  title: string,
  facts_: string,
  rows: { code: string; quantity: string; value?: string }[],
  held: StockLayerState[],
): ReviewCase {
  const list: DocumentRecord = {
    id: LIST,
    kind: 'inventory.list',
    schema: 'extracted-inventory-list-1',
    body: inventoryListSchema.parse({
      parserVersion: 'extracted-inventory-list-1',
      title: 'Lista de inventariere la 31.12.2026, gestiunea D1',
      company: { name: 'Magazin exemplu SRL', taxId: '100' },
      date: DATE,
      commission: { decision: '45', decisionDate: '2026-12-01', members: ['Pop Ion'] },
      assets: null,
      cash: null,
      bank: null,
      partners: null,
      stock: rows.map((row) => ({
        account: row.code === 'CAF-1' ? '371' : '3028',
        code: row.code,
        name: row.code === 'CAF-1' ? 'Cafea' : 'Hârtie',
        unit: row.code === 'CAF-1' ? 'H87' : 'XBX',
        quantity: row.quantity,
        warehouse: 'D1',
        ...(row.value ? { value: row.value } : {}),
      })),
    }) as never,
    bodyHash: 'list',
    docDate: DATE,
    partyId: null,
    currency: null,
    number: null,
    evidenceId: null,
  };
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) =>
      stockCount.evaluate(
        stockCountInput.parse({ date: DATE, documentIds: [LIST], evidenceId: DECISION }),
        shop(
          'fifo',
          held.map((row) => ({
            ...row,
            flows: {
              opening: { quantity: row.quantity, bani: row.bani },
              entered: { quantity: 0n, bani: 0n },
              left: { quantity: 0n, bani: 0n },
            },
          })),
          [list],
        ),
        rules,
      ),
    );
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.stock.accounts', {
          ...valueOf(register, 'ro.stock.accounts'),
          count: { surplus: '7588' },
        }),
      ),
    }),
  };
}

export const stockAccountsSpec: ReviewSpec = {
  key: 'ro.stock.accounts',
  kind: 'interpretation',
  act: OMFP,
  minutes: 15,
  readings: {
    engine:
      'Plusul constatat la inventariere intră în gestiune la valoarea stabilită de comisie, în contrapartidă cu cheltuiala contului de stoc (371 = 607, 30x = 60x, 381 = 608), așa cum funcțiunile conturilor 371, 301–303 și 381 împerechează plusurile de inventar; lipsa iese pe aceeași cheltuială.',
    alternative:
      'Plusul de inventar se înregistrează ca venit, în 7588 „Alte venituri din exploatare”, pentru că funcțiunea contului 607 nu îl numește în creditul său.',
  },
  question:
    'În ce cont se înregistrează, în contrapartidă cu contul de stoc, plusul de mărfuri, materiale sau ambalaje constatat la inventariere (funcțiunile conturilor 371, 301–303, 381 și 607, 601–603, 608; pct. 75 alin. (1))?',
  context: [`${OMFP}:conturi.60`, `${OMFP}:pct.289-292`],
  cases: [
    countCase(
      'Plus de mărfuri',
      'Registrul ține 10 pungi de cafea (100,00 lei); comisia numără 11 și evaluează plusul la 9,00 lei.',
      [{ code: 'CAF-1', quantity: '11', value: '9.00' }],
      [layer('lot-1', COFFEE, '371', 'fifo', 10_000n, 10_000n)],
    ),
    countCase(
      'Plus de materiale',
      'Registrul ține 5 cutii de hârtie (100,00 lei); comisia numără 6 și evaluează plusul la 20,00 lei.',
      [{ code: 'HRT-1', quantity: '6', value: '20.00' }],
      [layer('lot-2', PAPER, '3028', 'fifo', 5_000n, 10_000n)],
    ),
    countCase(
      'Fără diferențe',
      'Registrul și listele arată aceleași 10 pungi de cafea.',
      [{ code: 'CAF-1', quantity: '10' }],
      [layer('lot-1', COFFEE, '371', 'fifo', 10_000n, 10_000n)],
    ),
  ],
  gaps: [
    'Compensarea lipsurilor cu plusurile (OMF nr. 2.861/2009 pct. 40 alin. (3)–(5)) nu este construită: lipsurile și plusurile se înregistrează separat.',
    'Diferențele la recepție (lipsa pretinsă furnizorului pe 461, plusul nefacturat pe 408) urmează practica, nu un text: OMFP nr. 2.634/2015 (anexele 2–3, normele NIR) nu este disponibil.',
    'Prețul cu amănuntul (378, 4428) nu este construit.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The periodic weighted average's period (pct. 96 alin. (2))

function periodCase(title: string, facts_: string, flows: StockLayerState['flows']): ReviewCase {
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) =>
      stockPeriodCost.evaluate(
        periodCostInput.parse({ month: '2026-03' }),
        shop('periodic', [
          layer(
            'pool',
            COFFEE,
            '371',
            'periodic',
            flows!.opening.quantity + flows!.entered.quantity + flows!.left.quantity,
            flows!.opening.bani + flows!.entered.bani + flows!.left.bani,
            flows,
          ),
        ]),
        rules,
      ),
    );
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.stock.methods', {
          ...valueOf(register, 'ro.stock.methods'),
          periodMonths: 3,
        }),
      ),
    }),
  };
}

export const stockMethodsSpec: ReviewSpec = {
  key: 'ro.stock.methods',
  kind: 'interpretation',
  act: OMFP,
  minutes: 10,
  readings: {
    engine:
      'Politicile pot alege CMP (după fiecare recepție sau periodic), FIFO sau LIFO (pct. 96 alin. (1)); media periodică se calculează pe luna calendaristică, care nu depășește durata medie de stocare a unui magazin.',
    alternative:
      'Media periodică se calculează pe trimestru (sau pe perioada politicilor), cât timp nu depășește durata medie de stocare.',
  },
  question:
    'Pentru costul mediu ponderat calculat periodic (OMFP nr. 1.802/2014 pct. 96 alin. (2)), pe ce perioadă se calculează media, și se admite LIFO (alin. (1) lit. c))?',
  context: [`${OMFP}:pct.287`],
  cases: [
    periodCase(
      'O lună cu două recepții',
      'Martie: stoc inițial 10 pungi la 100,00 lei, intrări 10 la 120,00 lei, ieșiri 12 evaluate provizoriu la 126,00 lei; media lunii 11,00 lei, costul ieșirilor 132,00 lei.',
      {
        opening: { quantity: 10_000n, bani: 10_000n },
        entered: { quantity: 10_000n, bani: 12_000n },
        left: { quantity: -12_000n, bani: -12_600n },
      },
    ),
    periodCase(
      'Ieșiri deja la medie',
      'Martie: stoc inițial 10 la 100,00 lei, fără intrări, ieșiri 5 la 50,00 lei.',
      {
        opening: { quantity: 10_000n, bani: 10_000n },
        entered: { quantity: 0n, bani: 0n },
        left: { quantity: -5_000n, bani: -5_000n },
      },
    ),
    periodCase(
      'Recepție după un stoc epuizat',
      'Martie: stoc inițial 0, intrări 4 la 48,00 lei, ieșiri 2 evaluate provizoriu la 24,00 lei.',
      {
        opening: { quantity: 0n, bani: 0n },
        entered: { quantity: 4_000n, bani: 4_800n },
        left: { quantity: -2_000n, bani: -2_400n },
      },
    ),
  ],
  gaps: [
    'Durata medie de stocare a companiei nu este cunoscută aplicației; luna este o alegere a politicilor.',
    'Schimbarea metodei în cursul exercițiului (pct. 287) nu este acoperită: ieșirile sunt refuzate (STOCK_METHOD_CHANGED).',
  ],
};

// ---------------------------------------------------------------------------------------------
// Goods back to their supplier out of a weighted-average pool (pct. 95 alin. (1), 96 alin. (2))

const RECEIPT = '00000000-0000-4000-8000-00000000c007';

/**
 * A storno of the paper received on 10 March (10 boxes at 200,00 lei, Dr 3028 / Cr 408) on `date`,
 * the pool's days as given, under the weighted average after each receipt.
 */
function returnCase(
  title: string,
  facts_: string,
  date: string,
  days: { date: string; quantity: bigint; bani: bigint }[],
): ReviewCase {
  const quantity = days.reduce((sum, day) => sum + day.quantity, 0n);
  const bani = days.reduce((sum, day) => sum + day.bani, 0n);
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) => {
      const loaded = shop('average', [
        {
          ...layer('pool', PAPER, '3028', 'average', quantity, bani),
          days: days.map((day) => ({ ...day, date: day.date as LocalDate })),
        },
      ]);
      return reversal.evaluate(
        reversalInput.parse({
          entryId: RECEIPT,
          date,
          reason: 'Recepție restituită furnizorului.',
          evidenceId: DECISION,
          method: 'red',
        }),
        {
          ...loaded,
          entries: new Map([
            [
              RECEIPT,
              {
                id: RECEIPT,
                number: 2,
                date: '2026-03-10' as LocalDate,
                journalCode: 'DIVERSE',
                description: 'NIR 2',
                lines: [
                  { account: '3028', side: 'D', bani: 20_000n },
                  { account: '408', side: 'C', bani: 20_000n },
                ],
                taxEntries: [],
                stockMoves: [
                  {
                    item: PAPER,
                    warehouse: DEPOT,
                    account: '3028',
                    layer: 'pool',
                    quantity: 10_000n,
                    bani: 20_000n,
                    line: 0,
                  },
                ],
              },
            ],
          ]),
        },
        rules,
      );
    });
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(withValue(register, 'ro.stock.returns', { pool: 'average' })),
    }),
  };
}

export const stockReturnsSpec: ReviewSpec = {
  key: 'ro.stock.returns',
  kind: 'interpretation',
  act: OMFP,
  minutes: 10,
  readings: {
    engine:
      'Bunurile restituite furnizorului (pe nota lui de credit, sau prin stornarea recepției) ies din stocul evaluat la CMP la prețul lor de achiziție, valoarea cu care au intrat (pct. 95 alin. (1)), ca stornare a debitului 3xx = 401: media se reface pe stocul rămas, care preia diferența față de media zilei, așa cum o reducere ulterioară corectează stocurile încă deținute (pct. 76 alin. (2)); stocul golit în acea zi dă ce avea, restul pe cheltuială.',
    alternative:
      'Bunurile fungibile nu se deosebesc între ele (pct. 285 alin. (4)) și costul lor este cel al metodei (pct. 96 alin. (1)–(2)): ies la media zilei, iar diferența față de prețul de achiziție creditat de furnizor trece pe cheltuiala contului de stoc (601–608).',
  },
  question:
    'Un retur la furnizor sau stornarea unei recepții, dintr-un stoc evaluat la costul mediu ponderat după fiecare recepție, iese din gestiune la prețul de achiziție (media refăcută pe stocul rămas) sau la costul mediu al zilei, cu diferența pe cheltuieli (OMFP nr. 1.802/2014 pct. 95 alin. (1), 96 alin. (2))?',
  context: [`${OMFP}:pct.287`, `${OMFP}:conturi.30`],
  cases: [
    returnCase(
      'Stornare după o ieșire și o recepție ulterioară',
      'Hârtie: 1 martie 10 cutii la 100,00 lei, 10 martie 10 la 200,00 lei, 12 martie 15 consumate (225,00 lei), 25 martie 10 la 300,00 lei: 15 cutii la 375,00 lei (25,00 lei/cutie); recepția din 10 martie stornată pe 26 martie.',
      '2026-03-26',
      [
        { date: '2026-03-01', quantity: 10_000n, bani: 10_000n },
        { date: '2026-03-10', quantity: 10_000n, bani: 20_000n },
        { date: '2026-03-12', quantity: -15_000n, bani: -22_500n },
        { date: '2026-03-25', quantity: 10_000n, bani: 30_000n },
      ],
    ),
    returnCase(
      'Stornare înaintea oricărei ieșiri',
      'Hârtie: 1 martie 10 cutii la 100,00 lei, 10 martie 10 la 200,00 lei (20 la 300,00 lei, 15,00 lei/cutie); recepția din 10 martie stornată pe 11 martie, nimic consumat între timp.',
      '2026-03-11',
      [
        { date: '2026-03-01', quantity: 10_000n, bani: 10_000n },
        { date: '2026-03-10', quantity: 10_000n, bani: 20_000n },
      ],
    ),
    returnCase(
      'Stocul golit de stornare',
      'Hârtie: 1 martie 10 cutii la 100,00 lei, 10 martie 10 la 200,00 lei, 12 martie 10 consumate (150,00 lei): 10 cutii la 150,00 lei; recepția din 10 martie stornată pe 13 martie.',
      '2026-03-13',
      [
        { date: '2026-03-01', quantity: 10_000n, bani: 10_000n },
        { date: '2026-03-10', quantity: 10_000n, bani: 20_000n },
        { date: '2026-03-12', quantity: -10_000n, bani: -15_000n },
      ],
    ),
  ],
  gaps: [
    'OMFP nr. 1.802/2014 nu tratează returul la furnizor: singurele retururi pe care le numește sunt ale clienților (pct. 330), care corectează conturile vânzării.',
    'FIFO și LIFO scot lotul recepției, iar CMP calculat lunar ia prețul de achiziție (o intrare negativă a lunii, pe care costul lunar o mediază), oricare ar fi lectura.',
    'Ieșirile evaluate înaintea returului, la o medie care cuprindea bunurile returnate, nu se recalculează: diferența rămâne pe stoc sau pe cheltuială, după lectură.',
  ],
};
