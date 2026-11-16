import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRegister } from '../../xfactura-api/source/engine/engine';
import { loadCauses } from '../src/compare/causes';
import { DifferenceStore } from '../src/compare/store';
import type { CompanyFiling } from '../src/mapping/corpus';
import type { RefusedTransaction } from '../src/run/driver';
import { openReplayEngine } from '../src/run/engine';
import { deriveFacts, factStatements } from '../src/run/facts';
import {
  d300OptionsOf,
  d406OptionsOf,
  readFiledReturns,
  selectReturns,
  type FiledReturn,
  type ReturnForm,
} from '../src/run/filed-returns';
import { countMessages, explainingRefusals, replayReturns } from '../src/run/returns';
import { parseReturnsArguments } from '../../../scripts/differential/returns';
import { companyCui, replayBooksMapping } from './fixtures/replay-books';
import {
  d300Payload,
  d394Payload,
  filedD300,
  filedD394,
  payload,
  returnFilings,
  unreadCode,
  unreadSale,
} from './fixtures/returns-books';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function replay(
  filings: CompanyFiling[],
  returns: FiledReturn[],
  options: { forms?: ReturnForm[]; store?: DifferenceStore } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'xfactura-returns-'));
  directories.push(root);
  const store = options.store ?? new DifferenceStore(join(root, '.private'), 'synthetic', 'replay');
  const engine = join(root, 'engine');
  await mkdir(engine);
  const result = await replayReturns({
    alias: 'synthetic',
    filings,
    mapping: replayBooksMapping(filings),
    returns,
    forms: options.forms ?? ['D300', 'D394'],
    open: (clock) =>
      openReplayEngine(engine, {
        secret: 'synthetic-replay-secret-of-32-chars!',
        seed: 'test',
        clock,
        register: defaultRegister(),
      }),
    store,
    causes: await loadCauses(),
  });
  if (result.status !== 'completed') throw new Error('The journal replay was blocked.');
  const open = (await store.read()).filter(
    (item) => item.status === 'open' && item.scope.startsWith('returns:'),
  );
  return { result, summary: result.summary, store, open };
}

type Listed = {
  form: string;
  period: string;
  status: string;
  blocked?: { reason: string; codes: string[] };
  validation?: string;
  differences?: { total: number; explainedByRefusal: number; unexplained: number };
};
const listed = (summary: { returns: { list: unknown[] } }, form: string, period: string) =>
  (summary.returns.list as Listed[]).find((item) => item.form === form && item.period === period)!;

describe('rebuilding the filed returns from the replayed journal', () => {
  test("the engine's own D300 and D394 as filed show no difference, and one planted row is exactly that difference", async () => {
    const filings = returnFilings();
    const seed = readFiledReturns(
      [
        d300Payload(filedD300(1)),
        d394Payload(filedD394(1)),
        d300Payload(filedD300(3)),
        d394Payload(filedD394(3)),
      ],
      companyCui,
    );
    const first = await replay(filings, seed);
    // The register is the production one, every version as extracted.
    expect(first.summary.register.versions).toBeGreaterThan(0);
    expect(Object.keys(first.summary.register.byStatus)).toEqual(['extracted']);
    // The VAT status, period and VAT on collection rest on the filed returns.
    expect(first.summary.facts.recorded).toEqual({
      'vat.cash': 1,
      'vat.period': 1,
      'vat.status': 1,
    });
    expect(first.summary.facts.questions).toEqual([]);
    expect(listed(first.summary, 'D300', '2026-03')).toMatchObject({
      status: 'compared',
      validation: 'absent',
    });
    expect(listed(first.summary, 'D300', '2026-03').differences!.total).toBeGreaterThan(0);
    // January's sale and purchase have no invoice document in the replayed books: D394 cannot
    // list them, which is the engine's finding, stored as such.
    expect(listed(first.summary, 'D394', '2026-01')).toMatchObject({
      status: 'blocked',
      blocked: { reason: 'ENGINE_PROBLEMS', codes: ['D394_OPERATION'] },
    });
    expect(
      first.open
        .filter((item) => item.kind === 'return-blocked')
        .map(({ period, locator, class: kind }) => [period, locator.subject, kind]),
    ).toEqual([['2026-01', 'return:D394', 'unclassified']]);

    const engineXml = (form: string) =>
      first.result.prepared.find((item) => item.form === form && item.period === '2026-03')!.xml;
    const own = readFiledReturns(
      [payload('D300', engineXml('D300')), payload('D394', engineXml('D394'))],
      companyCui,
    );
    const second = await replay(filings, own);
    for (const form of ['D300', 'D394'])
      expect(listed(second.summary, form, '2026-03')).toMatchObject({
        status: 'compared',
        differences: { total: 0, explainedByRefusal: 0, unexplained: 0 },
      });
    expect(second.open).toEqual([]);

    const planted = engineXml('D300').replace(
      /R7_1="(\d+)"/,
      (_, value: string) => `R7_1="${Number(value) + 1}"`,
    );
    expect(planted).not.toBe(engineXml('D300'));
    const third = await replay(
      filings,
      readFiledReturns([payload('D300', planted), payload('D394', engineXml('D394'))], companyCui),
      { store: second.store },
    );
    expect(
      third.open.map(({ kind, period, locator, delta, class: kind_ }) => ({
        kind,
        period,
        locator,
        delta,
        class: kind_,
      })),
    ).toEqual([
      {
        kind: 'return-amount',
        period: '2026-03',
        locator: { subject: 'return:D300', field: 'declaratie300/@R7_1' },
        delta: '-1',
        class: 'unclassified',
      },
    ]);
    expect(third.summary.returns.byForm.D300).toMatchObject({
      compared: 1,
      differences: { total: 1, byClass: { amount: 1 }, bySection: { $root: 1 } },
    });
  });

  test('a fact no filed file states is a question, and the return that needs it stops on the engine gap', async () => {
    // A tax registration with no engine reading, and no VAT return filed.
    const filings = returnFilings({ vatRegime: '100030' });
    const { summary, open } = await replay(filings, [], { forms: ['D406'] });
    expect(summary.facts.recorded).toEqual({});
    for (const period of ['2026-01', '2026-02', '2026-03']) {
      const entry = listed(summary, 'D406', period);
      expect(entry.blocked!.reason).toBe('FACT_MISSING');
      expect(entry.blocked!.codes).toContain('D406_VAT_REGIME');
      expect(entry.blocked!.codes).toContain('VAT_PERIOD');
    }
    expect(summary.facts.questions.filter((question) => question.reason === 'NO_EVIDENCE')).toEqual(
      [
        {
          axis: 'vat.period',
          reason: 'NO_EVIDENCE',
          forms: ['D406'],
          periods: ['2026-01', '2026-02', '2026-03'],
        },
        {
          axis: 'vat.status',
          reason: 'NO_EVIDENCE',
          forms: ['D406'],
          periods: ['2026-01', '2026-02', '2026-03'],
        },
      ],
    );
    expect(open.map((item) => [item.kind, item.class, item.context?.cause?.reason])).toEqual([
      ['return-blocked', 'missing-evidence', 'FACT_MISSING'],
      ['return-blocked', 'missing-evidence', 'FACT_MISSING'],
      ['return-blocked', 'missing-evidence', 'FACT_MISSING'],
    ]);
  });

  test('a D300 difference resting on a refused transaction carries that refusal', async () => {
    const filings = returnFilings({ unread: true });
    const sale = { R9_1: Number(unreadSale.base.split('.')[0]), R9_2: 155 };
    const returns = readFiledReturns([d300Payload(filedD300(3, sale))], companyCui);
    const { summary, open } = await replay(filings, returns, { forms: ['D300'] });
    expect(summary.refusedTransactions).toBe(1);
    const entry = listed(summary, 'D300', '2026-03');
    expect(entry.differences!.total).toBeGreaterThan(0);
    // The refused sale's code has no reading: any row of its month may depend on it.
    expect(entry.differences!.explainedByRefusal).toBe(entry.differences!.total);
    const row = open.find((item) => item.locator.field === 'declaratie300/@R9_1')!;
    expect(row.context?.refusal).toMatchObject({ stage: 'translate', code: 'TAX_CODE_UNREAD' });
    expect(row.taxCodes).toEqual([unreadCode]);
    expect(row.class).toBe('unclassified');
  });
});

describe('the return replay’s parts', () => {
  const refusal = (
    month: string,
    taxes: { type: string; code: string }[],
    accounts: string[] = [],
  ): RefusedTransaction => ({
    month,
    subject: `migration:d406:${month}`,
    reason: 'translate:TAX_CODE_AMBIGUOUS',
    accounts,
    taxes,
  });

  test('a D300 row depends on the refusals whose codes the row quotes; totals on every VAT refusal', () => {
    const sale = refusal('2026-03', [{ type: '300', code: '310344' }]);
    const purchase = refusal('2026-03', [{ type: '300', code: '301104' }]);
    const elsewhere = refusal('2026-04', [{ type: '300', code: '310344' }]);
    const unrelated = refusal('2026-03', [], ['5121']);
    const all = [sale, purchase, elsewhere, unrelated];
    // R9 is rd. 9 (sales at 21%), R22 rd. 24 (purchases at 21%), R17 rd. 19 (a total).
    expect(explainingRefusals('D300', '2026-03', 'declaratie300/@R9_1', all)).toEqual([sale]);
    expect(explainingRefusals('D300', '2026-03', 'declaratie300/@R22_2', all)).toEqual([purchase]);
    expect(explainingRefusals('D300', '2026-03', 'declaratie300/@R17_2', all)).toEqual([
      sale,
      purchase,
    ]);
    expect(explainingRefusals('D300', '2026-Q1', 'declaratie300/@R9_1', all)).toEqual([sale]);
    // F20 rd. 01 (turnover) reads 701–708: a refusal on 704 explains it, one on 5121 does not.
    const revenue = refusal('2026-03', [], ['704']);
    expect(
      explainingRefusals('S1005', '2026', 'Bilant1005/F20/@F20_0012', [revenue, unrelated]),
    ).toEqual([revenue]);
  });

  test('facts follow the filed files, and files that disagree are a question', () => {
    const filings = returnFilings();
    const periods = filings.map((filing) => ({
      period: filing.filed.header.selection.start!.slice(0, 7),
      start: filing.filed.header.selection.start!,
      end: filing.filed.header.selection.end!,
      filing,
    }));
    const returns = readFiledReturns([d300Payload(filedD300(2))], companyCui);
    const { facts, conflicts } = deriveFacts(factStatements(periods, returns));
    expect(conflicts).toEqual([]);
    expect(
      facts.map(({ axis, value, effectiveFrom, reason }) => [axis, value, effectiveFrom, reason]),
    ).toEqual([
      ['vat.status', 'normal_vat', '2026-01-01', 'D406_TAX_REGISTRATION'],
      ['vat.cash', 'no', '2026-01-01', 'D406_TAX_REGISTRATION'],
      ['vat.period', 'monthly', '2026-01-01', 'D406_FILE_TYPE'],
    ]);
    const quarterly = readFiledReturns([d300Payload({ ...filedD300(3), type: 'T' })], companyCui);
    const disagreeing = deriveFacts(factStatements(periods, quarterly));
    expect(disagreeing.conflicts).toEqual([
      { axis: 'vat.period', from: '2026-01-01', to: '2026-03-31', reason: 'FACT_CONFLICT' },
    ]);
    expect(disagreeing.facts.some((fact) => fact.axis === 'vat.period')).toBe(false);
  });

  test('re-filings that differ without one rectifying return are the owner’s choice', () => {
    const returns = readFiledReturns(
      [
        d300Payload(filedD300(3)),
        d300Payload(filedD300(3, { R9_1: 1 })),
        d300Payload(filedD300(5)),
      ],
      companyCui,
    );
    const { selected, outsideReplay } = selectReturns(returns, ['D300'], {
      from: '2026-01',
      to: '2026-03',
    });
    expect(outsideReplay).toBe(1);
    expect(selected).toMatchObject([
      { form: 'D300', period: '2026-03', blocked: 'FILED_REFILINGS_AMBIGUOUS' },
    ]);
    expect(selected[0]!.collapsed).toHaveLength(2);
  });

  test('options come from the filed return, and a field it lacks stays absent', () => {
    const [d300] = readFiledReturns([d300Payload(filedD300(3))], companyCui);
    expect(d300OptionsOf(d300!.declaration)).toEqual({
      declarant: { lastName: 'Sintetic', firstName: 'Ana', role: 'Administrator' },
      caen: '6920',
      bank: 'Banca Sintetică',
      account: 'RO49AAAA1B31007593840000',
      phone: '0200000000',
      proRata: '100',
      refundRequested: false,
      previous: { unpaid: 0, negative: 0 },
    });
    const [filing] = returnFilings();
    filing!.filed.masterFiles.accounts.push({ id: '6051', standard: '6051' });
    expect(d406OptionsOf(filing!.filed, () => undefined)).toEqual({
      contact: { firstName: 'Ana', lastName: 'Sintetic', phone: '0200000000' },
      accounts: { '605': '6051' },
    });
  });

  test("ANAF's validator messages are counted by kind and rule, without their text", () => {
    expect(
      countMessages([
        'E: validari globale',
        ' eroare regula: R16: totalPlata_A (7) = capital (8)',
        'A: atentionare',
        ' atentionare regula: R16.1: suma (3)',
      ]),
    ).toEqual({ errors: 1, warnings: 1, rules: { R16: 1, 'R16.1': 1 } });
  });

  test('the command takes an alias, forms, a month range and an assumptions file', () => {
    expect(
      parseReturnsArguments([
        'synthetic',
        '--forms',
        'D300,D394',
        '--from',
        '2026-01',
        '--to',
        '2026-03',
        '--lab-assumptions',
        '.private/replay/synthetic/assumptions.json',
      ]),
    ).toEqual({
      alias: 'synthetic',
      forms: ['D300', 'D394'],
      from: '2026-01',
      to: '2026-03',
      assumptions: '.private/replay/synthetic/assumptions.json',
    });
    for (const args of [
      [],
      ['synthetic', '--forms', 'D100'],
      ['synthetic', '--forms', 'D300,D300'],
      ['synthetic', '--from', '2026-03', '--to', '2026-01'],
      ['synthetic', '--unknown', 'x'],
    ])
      expect(() => parseReturnsArguments(args)).toThrow('RETURNS_USAGE');
  });
});
