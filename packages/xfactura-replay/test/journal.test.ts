import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ParameterRegister, RuleContext } from 'xfactura-core/rules';
import { parseLocalDate } from 'xfactura-core/time';
import { loadState } from '../../xfactura-api/source/engine/kernel/state';
import type { ProposalView } from '../../xfactura-api/source/engine/kernel/views';
import { invoiceXml } from '../../xfactura-api/test/engine/fixtures/invoice';
import { scenario, type Scenario } from '../../xfactura-api/test/engine/scenario';
import {
  migrationJournal,
  migrationJournalInput,
  type MigrationJournalInput,
} from '../src/treatments/journal';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Line = MigrationJournalInput['lines'][number];
type Tax = MigrationJournalInput['taxEntries'][number];
type Position = Awaited<ReturnType<Scenario['engine']['positions']['list']>>[number];
type VatJournal = Awaited<ReturnType<Scenario['engine']['vat']['journal']>>;
type TrialBalance = Awaited<ReturnType<Scenario['engine']['reports']['trialBalance']>>;

async function company() {
  // An empty register proves that replay needs no legal parameter or assurance downgrade.
  const s = await scenario({
    name: 'Replay Sintetic SRL',
    treatments: [migrationJournal],
    register: new ParameterRegister([], []),
  });
  open.push(s);
  const { id: evidenceId } = await s.evidence('registru-sintetic.txt', 'Synthetic journal export');
  const supplier = await s.party('Furnizor Sintetic SRL', '90000001');
  const customer = await s.party('Client Sintetic SRL', '90000002');
  const authority = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'Autoritate Sintetică',
  });
  const input = (
    reference: string,
    lines: Line[],
    extra: Partial<MigrationJournalInput> = {},
  ): MigrationJournalInput => ({
    source: 'synthetic-books',
    reference,
    evidenceId,
    date: parseLocalDate('2026-10-05'),
    journalCode: 'DIVERSE',
    description: `Notă sintetică ${reference}`,
    lines,
    newItems: [],
    taxEntries: [],
    ...extra,
  });
  const book = async (entry: MigrationJournalInput) => {
    const proposal = await s.propose('migration.journal', entry);
    expect(proposal.status).toBe('proposed');
    expect(proposal.issues).toEqual([]);
    expect(proposal.rules.used).toEqual([]);
    const approved = await s.approve(proposal);
    expect(approved.effectHash).toBe(proposal.effectHash);
    const posted = await s.post(approved);
    expect(posted.status).toBe('posted');
    expect(posted.effectHash).toBe(proposal.effectHash);
    return posted;
  };
  const items = (openOnly = false) => s.list<Position>(s.owner, 'openItems.list', { openOnly });
  const vat = (direction: 'input' | 'output') =>
    s.invoke<VatJournal>(s.owner, 'vat.journal', {
      direction,
      from: '2026-10',
      to: '2026-10',
    });
  return { s, supplier, customer, authority, input, book, items, vat };
}
type Books = Awaited<ReturnType<typeof company>>;

// These are supplied fixture amounts and semantic codes, never a calculation of a tax rate.
function tax(line: number, extra: Partial<Tax> = {}): Tax {
  return {
    key: 'vat',
    tax: 'VAT',
    code: 'S-21',
    direction: 'input',
    base: '100.00',
    amount: '21.00',
    deductible: '21.00',
    taxPoint: parseLocalDate('2026-10-05'),
    exigibility: parseLocalDate('2026-10-05'),
    taxPeriod: '2026-10',
    line,
    booked: '21.00',
    attributes: { category: 'S', rate: '21' },
    ...extra,
  };
}

function purchase(b: Books, reference = 'purchase'): MigrationJournalInput {
  return b.input(
    reference,
    [
      { account: '628', side: 'D', amount: '100.00' },
      { account: '4426', side: 'D', amount: '21.00' },
      { account: '401', side: 'C', amount: '121.00', newItem: 'payable' },
    ],
    {
      journalCode: 'CUMPARARI',
      newItems: [{ ref: 'payable', partyId: b.supplier.id, dueDate: parseLocalDate('2026-10-20') }],
      taxEntries: [tax(1, { partyId: b.supplier.id })],
    },
  );
}

const balances = async (s: Scenario) =>
  Object.fromEntries((await s.trialBalance()).rows.map((row) => [row.account, row.closing]));
const debit = (amount: string) => ({ debit: amount, credit: '0.00' });
const credit = (amount: string) => ({ debit: '0.00', credit: amount });
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

async function evaluate(s: Scenario, entry: MigrationJournalInput) {
  const parsed = migrationJournalInput.parse(entry);
  const { loaded } = await s.db.read((tx) =>
    loadState(tx, s.company.id, migrationJournal.plan(parsed)),
  );
  return migrationJournal.evaluate(
    parsed,
    loaded,
    new RuleContext(new ParameterRegister([], []), 'posting'),
  );
}

describe('migration.journal through the private engine', () => {
  test('purchase invoice: supplied VAT, payable and source identity reach the registers', async () => {
    const b = await company();
    const entry = purchase(b);
    const posted = await b.book(entry);
    expect(posted.subject).toBe('migration:synthetic-books:purchase');
    expect(posted.effect).toMatchObject({
      date: entry.date,
      journalCode: 'CUMPARARI',
      description: entry.description,
      lines: [
        { account: '628', side: 'D', amount: '100.00' },
        { account: '4426', side: 'D', amount: '21.00' },
        { account: '401', side: 'C', amount: '121.00', partyId: b.supplier.id },
      ],
      explanation: {
        details: {
          source: entry.source,
          reference: entry.reference,
          evidenceId: entry.evidenceId,
        },
      },
    });
    expect(await balances(b.s)).toEqual({
      '401': credit('121.00'),
      '628': debit('100.00'),
      '4426': debit('21.00'),
    });
    expect(await b.items()).toEqual([
      expect.objectContaining({
        id: posted.effect!.openItems[0]!.id,
        kind: 'payable',
        account: '401',
        partyId: b.supplier.id,
        balance: '-121.00',
        dueDate: '2026-10-20',
      }),
    ]);
    expect((await b.vat('input')).rows).toEqual([
      expect.objectContaining({
        code: 'S-21',
        base: '100.00',
        vat: '21.00',
        deductible: '21.00',
        exigibility: '2026-10-05',
        counterparty: 'Furnizor Sintetic SRL',
      }),
    ]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('sales invoice: receivable and output VAT, including the optional source document', async () => {
    const b = await company();
    const evidence = await b.s.invoke<{ id: string }>(b.s.owner, 'evidence.record', {
      filename: 'factura-sintetica.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          direction: 'sale',
          number: 'V-SINT-1',
          date: '2026-10-05',
          counterparty: '90000002',
          net: '200.00',
          tax: '42.00',
          gross: '242.00',
        }),
      ).toString('base64'),
    });
    const document = await b.s.invoke<{ id: string }>(b.s.owner, 'invoices.import', {
      evidenceId: evidence.id,
    });
    const posted = await b.book(
      b.input(
        'sale',
        [
          { account: '4111', side: 'D', amount: '242.00', newItem: 'receivable' },
          { account: '704', side: 'C', amount: '200.00' },
          { account: '4427', side: 'C', amount: '42.00' },
        ],
        {
          journalCode: 'VANZARI',
          newItems: [{ ref: 'receivable', partyId: b.customer.id, documentId: document.id }],
          taxEntries: [
            tax(2, {
              direction: 'output',
              base: '200.00',
              amount: '42.00',
              deductible: '0.00',
              booked: '42.00',
              partyId: b.customer.id,
              documentId: document.id,
            }),
          ],
        },
      ),
    );
    expect(await balances(b.s)).toEqual({
      '704': credit('200.00'),
      '4111': debit('242.00'),
      '4427': credit('42.00'),
    });
    expect(await b.items()).toEqual([
      expect.objectContaining({
        id: posted.effect!.openItems[0]!.id,
        kind: 'receivable',
        account: '4111',
        balance: '242.00',
        document: 'V-SINT-1',
      }),
    ]);
    expect((await b.vat('output')).rows).toEqual([
      expect.objectContaining({
        code: 'S-21',
        base: '200.00',
        vat: '42.00',
        deductible: '0.00',
        document: 'V-SINT-1',
      }),
    ]);
    expect((await b.vat('input')).rows).toEqual([]);
  });

  test('bank payment settles the existing purchase payable and closes its item', async () => {
    const b = await company();
    const invoice = await b.book(purchase(b));
    const openItem = invoice.effect!.openItems[0]!.id;
    await b.book(
      b.input(
        'payment',
        [
          { account: '401', side: 'D', amount: '121.00', openItem, partyId: b.supplier.id },
          { account: '5121', side: 'C', amount: '121.00' },
        ],
        { date: parseLocalDate('2026-10-20'), journalCode: 'BANCA' },
      ),
    );
    expect(await balances(b.s)).toEqual({
      '401': debit('0.00'),
      '628': debit('100.00'),
      '4426': debit('21.00'),
      '5121': credit('121.00'),
    });
    expect((await b.s.trialBalance()).rows.find((row) => row.account === '401')?.current).toEqual({
      debit: '121.00',
      credit: '121.00',
    });
    expect(await b.items(true)).toEqual([]);
    expect(await b.items()).toEqual([
      expect.objectContaining({
        id: openItem,
        kind: 'payable',
        account: '401',
        partyId: b.supplier.id,
        balance: '0.00',
        balanceCurrency: '0.00',
      }),
    ]);
    expect((await b.vat('input')).totals).toEqual([
      { code: 'S-21', base: '100.00', vat: '21.00', deductible: '21.00' },
    ]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('reverse-charge purchase books input and output VAT together in one operation', async () => {
    const b = await company();
    const supplier = await b.s.invoke<{ id: string }>(b.s.owner, 'parties.create', {
      kind: 'eu_taxable',
      country: 'DE',
      taxId: 'DE123456789',
      name: 'Synthetic EU Supplier',
    });
    const posted = await b.book(
      b.input(
        'reverse-charge',
        [
          { account: '628', side: 'D', amount: '100.00' },
          { account: '401', side: 'C', amount: '100.00', newItem: 'supplier' },
          { account: '4426', side: 'D', amount: '21.00' },
          { account: '4427', side: 'C', amount: '21.00' },
        ],
        {
          newItems: [{ ref: 'supplier', partyId: supplier.id }],
          taxEntries: [
            tax(2, { key: 'input', code: 'RC-EU-SERV', partyId: supplier.id }),
            tax(3, {
              key: 'output',
              code: 'RC-EU-SERV',
              direction: 'output',
              deductible: '0.00',
              partyId: supplier.id,
            }),
          ],
        },
      ),
    );
    expect(posted.effect!.taxEntries).toHaveLength(2);
    expect(await balances(b.s)).toEqual({
      '401': credit('100.00'),
      '628': debit('100.00'),
      '4426': debit('21.00'),
      '4427': credit('21.00'),
    });
    expect(await b.items()).toEqual([
      expect.objectContaining({ kind: 'payable', balance: '-100.00' }),
    ]);
    const inputVat = await b.vat('input');
    const outputVat = await b.vat('output');
    expect(inputVat.totals).toEqual([
      { code: 'RC-EU-SERV', base: '100.00', vat: '21.00', deductible: '21.00' },
    ]);
    expect(outputVat.totals).toEqual([
      { code: 'RC-EU-SERV', base: '100.00', vat: '21.00', deductible: '0.00' },
    ]);
    expect(inputVat.rows[0]!.entry).toBe(outputVat.rows[0]!.entry);
  });

  test('VAT on collection: deferred purchase then a documentless release at payment', async () => {
    const b = await company();
    const entry = purchase(b, 'cash-vat-invoice');
    entry.lines[1]!.account = '4428';
    entry.taxEntries = [
      tax(1, {
        partyId: b.supplier.id,
        exigibility: null,
        attributes: { cashVat: 'supplier', category: 'S', rate: '21' },
      }),
    ];
    const invoice = await b.book(entry);
    expect(await balances(b.s)).toEqual({
      '401': credit('121.00'),
      '628': debit('100.00'),
      '4428': debit('21.00'),
    });
    expect((await b.items())[0]!.balance).toBe('-121.00');
    expect((await b.vat('input')).rows).toEqual([
      expect.objectContaining({ exigibility: null, vat: '21.00', deductible: '21.00' }),
    ]);
    await b.book(
      b.input(
        'cash-vat-payment',
        [
          {
            account: '401',
            side: 'D',
            amount: '121.00',
            openItem: invoice.effect!.openItems[0]!.id,
          },
          { account: '5121', side: 'C', amount: '121.00' },
        ],
        { date: parseLocalDate('2026-10-20') },
      ),
    );
    const release = b.input(
      'cash-vat-release',
      [
        { account: '4426', side: 'D', amount: '21.00' },
        { account: '4428', side: 'C', amount: '21.00' },
      ],
      {
        date: parseLocalDate('2026-10-20'),
        taxEntries: [
          tax(0, {
            key: 'release',
            exigibility: parseLocalDate('2026-10-20'),
            partyId: b.supplier.id,
            originTaxEntry: `${invoice.entry!.id}:vat`,
            attributes: { cashVat: 'supplier', release: 'payment' },
          }),
          tax(1, {
            key: 'deferred',
            base: '-100.00',
            amount: '-21.00',
            deductible: '-21.00',
            booked: '-21.00',
            exigibility: null,
            partyId: b.supplier.id,
            originTaxEntry: `${invoice.entry!.id}:vat`,
            attributes: { cashVat: 'supplier', release: 'payment' },
          }),
        ],
      },
    );
    const raw = await evaluate(b.s, release);
    expect(raw.issues).toEqual([]);
    expect(raw.effect!.taxEntries.every((entry) => entry.documentId === undefined)).toBe(true);
    expect(raw.effect!.taxEntries[0]!.originTaxEntry).toBe(`${invoice.entry!.id}:vat`);
    await b.book(release);
    expect(await balances(b.s)).toEqual({
      '401': debit('0.00'),
      '628': debit('100.00'),
      '4426': debit('21.00'),
      '4428': debit('0.00'),
      '5121': credit('121.00'),
    });
    const trial = await b.s.trialBalance();
    expect(trial.rows.find((row) => row.account === '401')?.current).toEqual({
      debit: '121.00',
      credit: '121.00',
    });
    expect(trial.rows.find((row) => row.account === '4428')?.current).toEqual({
      debit: '21.00',
      credit: '21.00',
    });
    expect(await b.items(true)).toEqual([]);
    expect(await b.items()).toEqual([
      expect.objectContaining({
        id: invoice.effect!.openItems[0]!.id,
        kind: 'payable',
        account: '401',
        balance: '0.00',
        balanceCurrency: '0.00',
      }),
    ]);
    const vat = await b.vat('input');
    expect(vat.rows.map((row) => [row.document, row.exigibility, row.vat])).toEqual([
      [null, null, '21.00'],
      [null, '2026-10-20', '21.00'],
      [null, null, '-21.00'],
    ]);
    expect(vat.totals).toEqual([
      { code: 'S-21', base: '100.00', vat: '21.00', deductible: '21.00' },
    ]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test.each(['4423', '4424'] as const)(
    'monthly VAT closing into %s uses settlement lines',
    async (account) => {
      const b = await company();
      await b.book(purchase(b));
      if (account === '4423')
        await b.book(
          b.input(
            'sale-before-closing',
            [
              { account: '4111', side: 'D', amount: '242.00', newItem: 'customer' },
              { account: '704', side: 'C', amount: '200.00' },
              { account: '4427', side: 'C', amount: '42.00' },
            ],
            {
              newItems: [{ ref: 'customer', partyId: b.customer.id }],
              taxEntries: [
                tax(2, {
                  direction: 'output',
                  base: '200.00',
                  amount: '42.00',
                  deductible: '0.00',
                  booked: '42.00',
                }),
              ],
            },
          ),
        );
      const before = { input: await b.vat('input'), output: await b.vat('output') };
      const taxSettlement = { tax: 'VAT', period: '2026-10' };
      const lines: Line[] =
        account === '4423'
          ? [
              { account: '4427', side: 'D', amount: '42.00', taxSettlement },
              { account: '4426', side: 'C', amount: '21.00', taxSettlement },
              { account, side: 'C', amount: '21.00', newItem: 'settlement' },
            ]
          : [
              { account: '4426', side: 'C', amount: '21.00', taxSettlement },
              { account, side: 'D', amount: '21.00', newItem: 'settlement' },
            ];
      const posted = await b.book(
        b.input('vat-closing', lines, {
          date: parseLocalDate('2026-10-31'),
          newItems: [{ ref: 'settlement', partyId: b.authority.id }],
        }),
      );
      const row = (
        account: string,
        current: { debit: string; credit: string },
        closing: { debit: string; credit: string },
      ) =>
        expect.objectContaining({
          account,
          opening: debit('0.00'),
          previous: debit('0.00'),
          current,
          total: current,
          closing,
        });
      const turnover =
        account === '4423'
          ? { debit: '405.00', credit: '405.00' }
          : { debit: '142.00', credit: '142.00' };
      const trial = await b.s.invoke<TrialBalance>(b.s.owner, 'ledger.trialBalance', {
        financialYearId: b.s.year.id,
      });
      expect(trial).toEqual({
        year: { id: b.s.year.id, from: '2026-01-01', to: '2026-12-31' },
        from: '2026-01-01',
        to: '2026-12-31',
        rows:
          account === '4423'
            ? [
                row('401', credit('121.00'), credit('121.00')),
                row('4111', debit('242.00'), debit('242.00')),
                row('4423', credit('21.00'), credit('21.00')),
                row('4426', { debit: '21.00', credit: '21.00' }, debit('0.00')),
                row('4427', { debit: '42.00', credit: '42.00' }, debit('0.00')),
                row('628', debit('100.00'), debit('100.00')),
                row('704', credit('200.00'), credit('200.00')),
              ]
            : [
                row('401', credit('121.00'), credit('121.00')),
                row('4424', debit('21.00'), debit('21.00')),
                row('4426', { debit: '21.00', credit: '21.00' }, debit('0.00')),
                row('628', debit('100.00'), debit('100.00')),
              ],
        totals: {
          opening: debit('0.00'),
          previous: debit('0.00'),
          current: turnover,
          total: turnover,
          closing:
            account === '4423'
              ? { debit: '342.00', credit: '342.00' }
              : { debit: '121.00', credit: '121.00' },
        },
      });
      expect(posted.effect!.taxEntries).toEqual([]);
      expect(await b.items()).toContainEqual(
        expect.objectContaining({
          account,
          partyId: b.authority.id,
          kind: account === '4423' ? 'tax.payable' : 'tax.receivable',
          balance: account === '4423' ? '-21.00' : '21.00',
        }),
      );
      expect(await b.vat('input')).toEqual(before.input);
      expect(await b.vat('output')).toEqual(before.output);
    },
  );

  test('payroll preserves gross pay per employee and tax-authority open items', async () => {
    const b = await company();
    const employeeA = await b.s.party('Angajat Sintetic A', '90000003');
    const employeeB = await b.s.party('Angajat Sintetic B', '90000004');
    await b.book(
      b.input(
        'payroll',
        [
          { account: '641', side: 'D', amount: '8000.00' },
          { account: '421', side: 'C', amount: '5000.00', newItem: 'employee-a' },
          { account: '421', side: 'C', amount: '3000.00', newItem: 'employee-b' },
          { account: '421', side: 'D', amount: '2075.00', newItem: 'employee-a' },
          { account: '421', side: 'D', amount: '1245.00', newItem: 'employee-b' },
          { account: '4315', side: 'C', amount: '2000.00', newItem: 'cas' },
          { account: '4316', side: 'C', amount: '800.00', newItem: 'cass' },
          { account: '444', side: 'C', amount: '520.00', newItem: 'income-tax' },
          { account: '646', side: 'D', amount: '180.00' },
          { account: '436', side: 'C', amount: '180.00', newItem: 'cam' },
        ],
        {
          journalCode: 'SALARII',
          newItems: [
            { ref: 'employee-a', partyId: employeeA.id },
            { ref: 'employee-b', partyId: employeeB.id },
            ...['cas', 'cass', 'income-tax', 'cam'].map((ref) => ({
              ref,
              partyId: b.authority.id,
            })),
          ],
        },
      ),
    );
    expect(await balances(b.s)).toEqual({
      '421': credit('4680.00'),
      '436': credit('180.00'),
      '444': credit('520.00'),
      '641': debit('8000.00'),
      '646': debit('180.00'),
      '4315': credit('2000.00'),
      '4316': credit('800.00'),
    });
    expect((await b.s.trialBalance()).rows.find((row) => row.account === '421')?.current).toEqual({
      debit: '3320.00',
      credit: '8000.00',
    });
    expect(
      (await b.items()).map(({ kind, account, partyId, balance }) => ({
        kind,
        account,
        partyId,
        balance,
      })),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'employee.payable', account: '421', partyId: employeeA.id, balance: '-2925.00' },
        { kind: 'employee.payable', account: '421', partyId: employeeB.id, balance: '-1755.00' },
        ...[
          ['4315', '-2000.00'],
          ['4316', '-800.00'],
          ['444', '-520.00'],
          ['436', '-180.00'],
        ].map(([account, balance]) => ({
          kind: 'tax.payable',
          account,
          partyId: b.authority.id,
          balance,
        })),
      ]),
    );
    expect(await b.items()).toHaveLength(6);
    expect((await b.vat('input')).rows).toEqual([]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('derives every chart-controlled open-item kind, including deferrals, accruals and loans', async () => {
    const b = await company();
    const controls = [
      ['401', 'payable', 'C'],
      ['4111', 'receivable', 'D'],
      ['4091', 'advance.paid', 'D'],
      ['419', 'advance.received', 'C'],
      ['408', 'accrual.payable', 'C'],
      ['418', 'accrual.receivable', 'D'],
      ['471', 'deferral.expense', 'D'],
      ['472', 'deferral.revenue', 'C'],
      ['421', 'employee.payable', 'C'],
      ['4423', 'tax.payable', 'C'],
      ['4424', 'tax.receivable', 'D'],
      ['1621', 'loan.payable', 'C'],
      ['1682', 'loan.interest', 'C'],
    ] as const;
    const posted = await b.book(
      b.input(
        'control-kinds',
        controls.flatMap(([account, , side]) => [
          { account, side, amount: '10.00', newItem: `item-${account}` },
          { account: '5121', side: side === 'D' ? 'C' : 'D', amount: '10.00' },
        ]),
        {
          newItems: controls.map(([account]) => ({
            ref: `item-${account}`,
            partyId: b.supplier.id,
          })),
        },
      ),
    );
    expect(
      posted.effect!.openItems.map(({ controlAccount, kind, normalSide }) => [
        controlAccount,
        kind,
        normalSide,
      ]),
    ).toEqual(controls.map((row) => [...row]));
    const positions = await b.items();
    expect(positions).toHaveLength(controls.length);
    const trial = await balances(b.s);
    for (const [account, kind, side] of controls) {
      expect(positions).toContainEqual(
        expect.objectContaining({ account, kind, balance: side === 'D' ? '10.00' : '-10.00' }),
      );
      expect(trial[account]).toEqual(side === 'D' ? debit('10.00') : credit('10.00'));
    }
    expect((await b.vat('input')).rows).toEqual([]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('preserves supplied currency, rate, analytics and signed red-storno amounts', async () => {
    const b = await company();
    const currency = { code: 'EUR', amount: '100.01', rate: '5.00010002', rateId: 'source-rate-1' };
    const analytics = { costCenter: 'ADMIN', project: 'P1', item: 'source-asset-1' };
    const invoice = await b.book(
      b.input(
        'foreign-invoice',
        [
          { account: '628', side: 'D', amount: '500.03', analytics, memo: 'Detaliu din sursă' },
          { account: '401', side: 'C', amount: '500.03', newItem: 'foreign', currency },
        ],
        { newItems: [{ ref: 'foreign', partyId: b.supplier.id }] },
      ),
    );
    expect(invoice.effect!.lines[0]).toMatchObject({ analytics, memo: 'Detaliu din sursă' });
    expect(invoice.effect!.lines[1]!.currency).toEqual(currency);
    expect(invoice.effect!.openItems[0]!.currency).toBe('EUR');
    const storno = await b.book(
      b.input('foreign-red-storno', [
        { account: '628', side: 'D', amount: '-10.03', analytics },
        {
          account: '401',
          side: 'C',
          amount: '-10.03',
          openItem: invoice.effect!.openItems[0]!.id,
          currency: { ...currency, amount: '-2.01' },
        },
      ]),
    );
    expect(storno.effect!.lines[1]).toMatchObject({
      side: 'C',
      amount: '-10.03',
      currency: { ...currency, amount: '-2.01' },
    });
    expect(await balances(b.s)).toEqual({ '401': credit('490.00'), '628': debit('490.00') });
    expect(await b.items()).toEqual([
      expect.objectContaining({ currency: 'EUR', balance: '-490.00', balanceCurrency: '-98.00' }),
    ]);
  });

  test('a non-deductible tax entry may book zero without a tax-controlled line', async () => {
    const b = await company();
    const { line: _line, ...unlinked } = tax(0, {
      deductible: '0.00',
      booked: '0.00',
      partyId: b.supplier.id,
    });
    const posted = await b.book(
      b.input(
        'non-deductible',
        [
          { account: '628', side: 'D', amount: '121.00' },
          { account: '401', side: 'C', amount: '121.00', newItem: 'supplier' },
        ],
        {
          newItems: [{ ref: 'supplier', partyId: b.supplier.id }],
          taxEntries: [unlinked],
        },
      ),
    );
    expect(await balances(b.s)).toEqual({ '401': credit('121.00'), '628': debit('121.00') });
    expect(await b.items()).toEqual([
      expect.objectContaining({
        id: posted.effect!.openItems[0]!.id,
        kind: 'payable',
        account: '401',
        partyId: b.supplier.id,
        balance: '-121.00',
        balanceCurrency: '-121.00',
      }),
    ]);
    const journal = await b.vat('input');
    expect(journal.rows).toEqual([
      expect.objectContaining({
        entry: posted.entry!.number,
        date: '2026-10-05',
        taxPeriod: '2026-10',
        exigibility: '2026-10-05',
        code: 'S-21',
        base: '100.00',
        vat: '21.00',
        deductible: '0.00',
        counterparty: 'Furnizor Sintetic SRL',
      }),
    ]);
    expect(journal.totals).toEqual([
      { code: 'S-21', base: '100.00', vat: '21.00', deductible: '0.00' },
    ]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('partially deductible VAT preserves the portion booked to the expense', async () => {
    const b = await company();
    const entry = purchase(b, 'partially-deductible');
    entry.lines = [
      { account: '628', side: 'D', amount: '100.00' },
      { account: '628', side: 'D', amount: '10.50' },
      { account: '4426', side: 'D', amount: '10.50' },
      { account: '401', side: 'C', amount: '121.00', newItem: 'payable' },
    ];
    entry.taxEntries = [tax(2, { deductible: '10.50', booked: '10.50', partyId: b.supplier.id })];
    const posted = await b.book(entry);
    expect(posted.effect!.lines).toEqual([
      expect.objectContaining({ account: '628', side: 'D', amount: '100.00' }),
      expect.objectContaining({ account: '628', side: 'D', amount: '10.50' }),
      expect.objectContaining({ account: '4426', side: 'D', amount: '10.50' }),
      expect.objectContaining({ account: '401', side: 'C', amount: '121.00' }),
    ]);
    expect(await balances(b.s)).toEqual({
      '401': credit('121.00'),
      '628': debit('110.50'),
      '4426': debit('10.50'),
    });
    expect(await b.items()).toEqual([
      expect.objectContaining({
        id: posted.effect!.openItems[0]!.id,
        kind: 'payable',
        account: '401',
        partyId: b.supplier.id,
        balance: '-121.00',
      }),
    ]);
    const journal = await b.vat('input');
    expect(journal.rows).toEqual([
      expect.objectContaining({
        entry: posted.entry!.number,
        code: 'S-21',
        base: '100.00',
        vat: '21.00',
        deductible: '10.50',
        counterparty: 'Furnizor Sintetic SRL',
      }),
    ]);
    expect(journal.totals).toEqual([
      { code: 'S-21', base: '100.00', vat: '21.00', deductible: '10.50' },
    ]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('an EUR purchase preserves the supplied tax currency fields through posting', async () => {
    const b = await company();
    const evidence = await b.s.invoke<{ id: string }>(b.s.owner, 'evidence.record', {
      filename: 'factura-eur-sintetica.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          number: 'F-EUR-1',
          date: '2026-10-05',
          counterparty: '90000001',
          currency: 'EUR',
          net: '100.00',
          tax: '21.00',
          gross: '121.00',
        }),
      ).toString('base64'),
    });
    const document = await b.s.invoke<{ id: string }>(b.s.owner, 'invoices.import', {
      evidenceId: evidence.id,
    });
    const currency = {
      code: 'EUR',
      baseMinor: '10000',
      taxMinor: '2100',
      rate: '5.00000000',
      rateId: 'source-eur-2026-10-05',
    };
    const lineCurrency = { code: currency.code, rate: currency.rate, rateId: currency.rateId };
    const entry = b.input(
      'eur-purchase',
      [
        {
          account: '628',
          side: 'D',
          amount: '500.00',
          currency: { ...lineCurrency, amount: '100.00' },
        },
        {
          account: '4426',
          side: 'D',
          amount: '105.00',
          currency: { ...lineCurrency, amount: '21.00' },
        },
        {
          account: '401',
          side: 'C',
          amount: '605.00',
          newItem: 'supplier',
          currency: { ...lineCurrency, amount: '121.00' },
        },
      ],
      {
        journalCode: 'CUMPARARI',
        newItems: [{ ref: 'supplier', partyId: b.supplier.id, documentId: document.id }],
        taxEntries: [
          tax(1, {
            base: '500.00',
            amount: '105.00',
            deductible: '105.00',
            booked: '105.00',
            partyId: b.supplier.id,
            documentId: document.id,
            currency,
          }),
        ],
      },
    );
    const expectedCurrency = { ...currency, baseMinor: 10000n, taxMinor: 2100n };
    const raw = await evaluate(b.s, entry);
    expect(raw.issues).toEqual([]);
    expect(raw.effect!.taxEntries[0]!.currency).toEqual(expectedCurrency);
    const posted = await b.book(entry);
    const { loaded } = await b.s.db.read((tx) =>
      loadState(tx, b.s.company.id, { entries: [posted.entry!.id] }),
    );
    expect(loaded.entries.get(posted.entry!.id)!.taxEntries[0]!.currency).toEqual(expectedCurrency);
    expect(await balances(b.s)).toEqual({
      '401': credit('605.00'),
      '628': debit('500.00'),
      '4426': debit('105.00'),
    });
    expect(await b.items()).toEqual([
      expect.objectContaining({
        id: posted.effect!.openItems[0]!.id,
        kind: 'payable',
        account: '401',
        partyId: b.supplier.id,
        currency: 'EUR',
        balance: '-605.00',
        balanceCurrency: '-121.00',
        document: 'F-EUR-1',
      }),
    ]);
    const journal = await b.vat('input');
    expect(journal.rows).toEqual([
      expect.objectContaining({
        entry: posted.entry!.number,
        document: 'F-EUR-1',
        documentDate: '2026-10-05',
        code: 'S-21',
        base: '500.00',
        vat: '105.00',
        deductible: '105.00',
      }),
    ]);
    expect(journal.totals).toEqual([
      { code: 'S-21', base: '500.00', vat: '105.00', deductible: '105.00' },
    ]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('an approved settlement becomes stale when the payable changes', async () => {
    const b = await company();
    const invoice = await b.book(purchase(b));
    const payment = (reference: string, amount: string) =>
      b.input(reference, [
        { account: '401', side: 'D', amount, openItem: invoice.effect!.openItems[0]!.id },
        { account: '5121', side: 'C', amount },
      ]);
    const pending = await b.s.approve(
      await b.s.propose('migration.journal', payment('pending', '121.00')),
    );
    await b.book(payment('partial', '1.00'));
    expect((await b.s.refused(b.s.post(pending)))?.code).toBe('STALE');
    expect((await b.items())[0]!.balance).toBe('-120.00');
  });

  test('the subject prevents duplicate booking and namespaces references by source', async () => {
    const b = await company();
    const entry = purchase(b);
    const first = await b.s.propose('migration.journal', entry);
    const repeated = await b.s.propose('migration.journal', entry);
    expect(repeated.id).toBe(first.id);
    expect(repeated.version).toBe(first.version);
    expect(
      (
        await b.s.refused(
          b.s.propose('migration.journal', {
            ...entry,
            description: 'Altă descriere pentru aceeași referință',
          }),
        )
      )?.code,
    ).toBe('SUBJECT_EXISTS');
    await b.s.post(await b.s.approve(first));
    const postedAgain = await b.s.propose('migration.journal', entry);
    expect(postedAgain.id).toBe(first.id);
    expect(postedAgain.status).toBe('posted');
    expect(
      (
        await b.s.refused(
          b.s.propose('migration.journal', {
            ...entry,
            description: 'O altă înregistrare',
          }),
        )
      )?.code,
    ).toBe('SUBJECT_EXISTS');
    expect((await b.s.trialBalance()).totals.current).toEqual({
      debit: '121.00',
      credit: '121.00',
    });
    expect(await b.items()).toHaveLength(1);
    expect((await b.vat('input')).rows).toHaveLength(1);
    const other = await b.s.propose('migration.journal', { ...entry, source: 'other-books' });
    expect(other.subject).toBe('migration:other-books:purchase');
    expect(other.id).not.toBe(first.id);
  });

  test.each([
    ['VAT line without a tax entry', 'TAX_LINE_UNEXPLAINED'],
    ['control line without an open item', 'CONTROL_OPEN_ITEM'],
  ])('%s is refused by validateEffect, before database posting', async (_shape, code) => {
    const b = await company();
    const entry = purchase(b, code);
    if (code === 'TAX_LINE_UNEXPLAINED') entry.taxEntries = [];
    else {
      delete entry.lines[2]!.newItem;
      entry.newItems = [];
    }
    // The treatment accepts the supplied effect; the kernel adds its structural refusal.
    expect((await evaluate(b.s, entry)).issues).toEqual([]);
    const proposal = await b.s.propose('migration.journal', entry);
    expect(proposal.status).toBe('blocked');
    expect(codes(proposal)).toEqual([code]);
    expect((await b.s.refused(b.s.approve(proposal)))?.code).toBe('BLOCKING_ISSUES');
    expect((await b.s.refused(b.s.post(proposal)))?.code).toBe('APPROVAL_REQUIRED');
    expect((await b.s.trialBalance()).rows).toEqual([]);
    expect(await b.items()).toEqual([]);
    expect((await b.vat('input')).rows).toEqual([]);
  });

  test('the treatment reports unknown records and incoherent new-item and tax-line references', async () => {
    const b = await company();
    const entry = b.input(
      'incoherent',
      [
        { account: '628', side: 'D', amount: '100.00', newItem: 'expense', partyId: randomUUID() },
        { account: '5121', side: 'C', amount: '100.00', openItem: randomUUID() },
      ],
      {
        evidenceId: randomUUID(),
        newItems: [{ ref: 'expense', partyId: randomUUID() }],
        taxEntries: [tax(0, { partyId: randomUUID(), documentId: randomUUID() })],
      },
    );
    const raw = await evaluate(b.s, entry);
    expect(raw.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EVIDENCE', path: 'evidenceId' }),
        expect.objectContaining({ code: 'PARTY', path: 'newItems.0.partyId' }),
        expect.objectContaining({ code: 'PARTY', path: 'lines.0.partyId' }),
        expect.objectContaining({ code: 'OPEN_ITEM_UNKNOWN', path: 'lines.1.openItem' }),
        expect.objectContaining({ code: 'NOT_CONTROL_ACCOUNT', path: 'lines.0' }),
        expect.objectContaining({ code: 'TAX_ENTRY_LINE', path: 'taxEntries.0' }),
        expect.objectContaining({ code: 'PARTY', path: 'taxEntries.0.partyId' }),
        expect.objectContaining({ code: 'DOCUMENT', path: 'taxEntries.0.documentId' }),
      ]),
    );
    expect((await b.s.propose('migration.journal', entry)).status).toBe('blocked');
  });

  test('the treatment reports undeclared and unused new items and invalid tax-line indexes', async () => {
    const b = await company();
    const entry = b.input(
      'bad-references',
      [
        { account: '628', side: 'D', amount: '100.00' },
        { account: '401', side: 'C', amount: '100.00', newItem: 'undeclared' },
      ],
      {
        newItems: [{ ref: 'unused', partyId: b.supplier.id }],
        taxEntries: [tax(99)],
      },
    );
    expect((await evaluate(b.s, entry)).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'NEW_ITEM', path: 'lines.1.newItem' }),
        expect.objectContaining({ code: 'NEW_ITEM_UNUSED', path: 'newItems.0' }),
        expect.objectContaining({ code: 'TAX_ENTRY_LINE', path: 'taxEntries.0' }),
      ]),
    );
    const proposal = await b.s.propose('migration.journal', entry);
    expect(proposal.status).toBe('blocked');
    expect(codes(proposal)).toEqual(
      expect.arrayContaining(['NEW_ITEM', 'NEW_ITEM_UNUSED', 'TAX_ENTRY_LINE']),
    );
    expect((await b.s.refused(b.s.approve(proposal)))?.code).toBe('BLOCKING_ISSUES');
    expect((await b.s.refused(b.s.post(proposal)))?.code).toBe('APPROVAL_REQUIRED');
    expect((await b.s.trialBalance()).rows).toEqual([]);
    expect(await b.items()).toEqual([]);
    expect((await b.vat('input')).rows).toEqual([]);
    expect((await b.vat('output')).rows).toEqual([]);
  });

  test('input validation refuses rounding, duplicate refs and ambiguous open-item references', async () => {
    const b = await company();
    const entry = purchase(b);
    for (const lines of [
      [{ ...entry.lines[0]!, amount: '100.001' }, ...entry.lines.slice(1)],
      [...entry.lines.slice(0, 2), { ...entry.lines[2]!, openItem: randomUUID() }],
      [
        entry.lines[0]!,
        entry.lines[1]!,
        {
          ...entry.lines[2]!,
          currency: { code: 'JPY', amount: '1.01', rate: '0.03', rateId: 'source' },
        },
      ],
    ])
      expect(migrationJournalInput.safeParse({ ...entry, lines }).success).toBe(false);
    expect(migrationJournalInput.safeParse({ ...entry, source: 'ambiguous:source' }).success).toBe(
      false,
    );
    expect(
      migrationJournalInput.safeParse({
        ...entry,
        newItems: [entry.newItems[0]!, entry.newItems[0]!],
      }).success,
    ).toBe(false);
    for (const invalid of [{ baseMinor: '100.00' }, { taxMinor: '21.00' }])
      expect(
        migrationJournalInput.safeParse({
          ...entry,
          taxEntries: [
            {
              ...entry.taxEntries[0]!,
              currency: {
                code: 'EUR',
                baseMinor: '10000',
                taxMinor: '2100',
                rate: '5.00',
                rateId: 'source',
                ...invalid,
              },
            },
          ],
        }).success,
      ).toBe(false);
  });

  test('the treatment is unavailable to agents even through generic proposals.propose', async () => {
    const b = await company();
    const grant = await b.s.invoke<{ token: string }>(b.s.reviewer, 'agents.issue', {
      name: 'Agent sintetic',
      scopes: ['toolset:books', 'proposals.propose'],
      expiresAt: b.s.expiresIn(1),
    });
    const agent = await b.s.engine.agents.authenticate(grant.token, b.s.company.id);
    const { capabilities } = await b.s.invoke<{ capabilities: { id: string }[] }>(
      agent,
      'capabilities.list',
    );
    expect(capabilities).toContainEqual(expect.objectContaining({ id: 'proposals.propose' }));
    expect(capabilities.some((item) => item.id.startsWith('migration.journal'))).toBe(false);
    expect((await b.s.refused(b.s.propose('migration.journal', purchase(b), agent)))?.code).toBe(
      'AGENT_SCOPE',
    );
    expect(
      (
        await b.s.refused(
          b.s.invoke(agent, 'proposals.propose', {
            treatment: 'migration.journal',
            input: purchase(b),
          }),
        )
      )?.code,
    ).toBe('AGENT_SCOPE');
  });
});
