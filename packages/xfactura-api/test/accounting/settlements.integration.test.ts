import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Accounting } from '../../source/accounting/application';
import type { Actor } from '../../source/accounting/commands';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { createAuth } from '../../source/accounting/auth';
import { createApp } from '../../source/accounting/app';
import {
  postingOutput,
  positionOutput,
  proposalOutput,
} from '../../source/accounting/capability-contracts';
import { vatSummaryOutput } from '../../source/accounting/vat-registers';
import { LocalObjectStore } from '../../source/accounting/object-store';
import {
  generalBodySchema,
  type CreditNoteInput,
  type SettlementInput,
} from '../../source/accounting/domain';
import {
  invoiceCredits,
  invoicePostings,
  invoiceSettlements,
  movementPostings,
  journalLines,
  treasuryAccounts,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID();
const review = (value: { version: number; hash: string }) => ({
  version: value.version,
  hash: value.hash,
});
const secret = 'synthetic-settlement-secret-at-least-32-characters';
let directory: string,
  db: Database,
  service: Accounting,
  ownerId: string,
  objects: LocalObjectStore;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-settlements-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  const user = await createAuth(
    db,
    { publicUrl: 'http://localhost:3000', authSecret: secret },
    true,
  ).api.signUpEmail({
    body: {
      email: 'settlements@example.test',
      name: 'Settlement reviewer',
      password: 'synthetic-settlement-password',
    },
  });
  ownerId = user.user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(year = 2026, vat: 'normal_vat' | 'non_vat' = 'normal_vat') {
  const company = await service.companies.create(ownerId, key(), {
    name: 'Settlement fixture SRL',
    cui: '12345678',
    year,
  });
  const actor = { actorId: ownerId, companyId: company.id };
  const financialYear = (await service.foundation.years(actor)).find(
    (item) => item.kind === 'financial',
  )!;
  const proof = await source(
    actor,
    'independent-proof.txt',
    'Retained independent synthetic registration, service and adjustment evidence',
  );
  await service.foundation.recordRegime(actor, key(), {
    axis: 'vat',
    value: vat,
    effectiveFrom: `${year}-01-01`,
    evidenceId: proof.id,
  });
  if (vat === 'normal_vat')
    await service.foundation.recordRegime(actor, key(), {
      axis: 'vat_collection',
      value: 'no',
      effectiveFrom: `${year}-01-01`,
      evidenceId: proof.id,
    });
  const opening = await service.ledger.propose(actor, key(), {
    financialYearId: financialYear.id,
    evidenceId: proof.id,
    date: financialYear.from,
    purpose: 'opening',
    description: 'Poziție inițială verificată',
    sourceReference: 'opening',
    lines: [
      { account: '5121', debit: '1000.00', credit: '0.00' },
      { account: '1012', debit: '0.00', credit: '1000.00' },
    ],
  });
  const f = { actor, financialYear, proof, company, vat };
  await approvePost(f, opening);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function source(actor: Actor, filename: string, text: string) {
  return service.documents.record(actor, key(), {
    filename,
    mediaType: filename.endsWith('.xml')
      ? 'application/xml'
      : filename.endsWith('.csv')
        ? 'text/csv'
        : 'text/plain',
    bytes: Buffer.from(text),
  });
}
async function approvePost(
  f: Pick<Fixture, 'actor'>,
  proposal: { id: string; version: number; hash: string },
) {
  const approval = await service.books.approve(f.actor, key(), proposal.id, review(proposal));
  const entry = await service.ledger.post(f.actor, key(), { id: proposal.id, ...review(proposal) });
  return { entry, approval };
}
async function importInvoice(f: Fixture, input: XmlInput = {}) {
  const original = await source(f.actor, `${key()}.xml`, invoiceXml(input));
  return service.invoices.import(f.actor, key(), { evidenceId: original.id });
}
async function invoice(f: Fixture, input: XmlInput = {}) {
  const value = await importInvoice(f, input);
  const proposal = await service.invoices.propose(f.actor, key(), {
    invoiceId: value.id,
    financialYearId: f.financialYear.id,
    recognitionDate: value.body.issueDate,
    serviceDate: value.body.issueDate,
    taxPointDate: value.body.issueDate,
    treatmentEvidenceId: f.proof.id,
    account: value.direction === 'sale' ? '704' : '628',
    deduction:
      value.direction === 'sale' || f.vat === 'non_vat' || input.category === 'O' ? 'none' : 'full',
    counterpartyVatCollection: 'no',
  });
  const posted = await approvePost(f, proposal);
  return { invoice: value, proposal, ...posted };
}
async function statement(
  f: Fixture,
  input: {
    rows: Array<{ id: string; date: string; amount: string }>;
    from?: string;
    to?: string;
    opening: string;
    closing: string;
    account?: string;
  },
) {
  const original = await source(
    f.actor,
    `${key()}.csv`,
    `movement_id,booking_date,amount,currency,reference\n${input.rows.map((row) => `${row.id},${row.date},${row.amount},RON,Documented ${row.id}`).join('\n')}\n`,
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: original.id,
    bankAccount: input.account ?? 'RO00FIXTURE',
    statementId: key(),
    from: input.from ?? '2026-10-01',
    to: input.to ?? '2026-10-31',
    opening: input.opening,
    closing: input.closing,
  });
  const state = await service.overview(f.actor, f.financialYear.id);
  return input.rows.map((row) => state.movements.find((movement) => movement.sourceId === row.id)!);
}
function allocation(
  f: Fixture,
  movementId: string,
  invoiceId: string,
  amount: string,
): SettlementInput {
  return { financialYearId: f.financialYear.id, movementId, allocations: [{ invoiceId, amount }] };
}
async function credit(
  f: Fixture,
  original: Awaited<ReturnType<typeof invoice>>,
  input: XmlInput & { kind?: CreditNoteInput['kind']; decisionDate?: string },
) {
  const document = await importInvoice(f, {
    ...input,
    direction: original.invoice.direction,
    credit: true,
    originalNumber: original.invoice.body.number,
    number: input.number ?? key(),
  });
  const body: CreditNoteInput = {
    invoiceId: document.id,
    originalInvoiceId: original.invoice.id,
    financialYearId: f.financialYear.id,
    recognitionDate: document.body.issueDate,
    decisionDate: input.decisionDate ?? document.body.issueDate,
    treatmentEvidenceId: f.proof.id,
    kind: input.kind ?? 'commercial_discount',
    periodBasis: 'current_period_event',
    reason: 'Reducere comercială negociată ulterior prestării, cu documente păstrate',
  };
  return {
    document,
    body,
    proposal: await service.invoices.proposeCreditNote(f.actor, key(), body),
  };
}

describe('native invoice positions, credits and treasury reconciliation', () => {
  test('a VAT purchase, partial payment, separate fee, closed month and following-month credit reconcile exactly', async () => {
    const f = await fixture();
    const purchase = await invoice(f);
    const [pay, fee] = await statement(f, {
      rows: [
        { id: 'PAY-1', date: '2026-10-05', amount: '-40.00' },
        { id: 'FEE-1', date: '2026-10-05', amount: '-2.00' },
      ],
      opening: '1000.00',
      closing: '958.00',
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, pay.id, purchase.invoice.id, '40.00'),
      ),
    );
    await approvePost(
      f,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        movementId: fee.id,
        allocations: [],
        fee: { amount: '2.00', account: '627', evidenceId: f.proof.id },
      }),
    );
    expect(
      await service.positions.read(f.actor, { invoiceId: purchase.invoice.id, date: '2026-10-31' }),
    ).toMatchObject({ gross: '121.00', credited: '0.00', settled: '40.00', balance: '81.00' });
    await service.periods.close(f.actor, key(), '2026-10-01');
    const note = await credit(f, purchase, {
      date: '2026-11-05',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    });
    expect(generalBodySchema.parse(note.proposal.body).lines).toEqual([
      { account: '401', debit: '24.20', credit: '0.00' },
      { account: '609', debit: '0.00', credit: '20.00' },
      { account: '4426', debit: '0.00', credit: '4.20' },
    ]);
    await approvePost(f, note.proposal);
    const [finalPay] = await statement(f, {
      rows: [{ id: 'PAY-2', date: '2026-11-10', amount: '-56.80' }],
      from: '2026-11-01',
      to: '2026-11-30',
      opening: '958.00',
      closing: '901.20',
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, finalPay.id, purchase.invoice.id, '56.80'),
      ),
    );
    expect(
      await service.positions.read(f.actor, { invoiceId: purchase.invoice.id, date: '2026-11-30' }),
    ).toMatchObject({
      gross: '121.00',
      credited: '24.20',
      settled: '96.80',
      balance: '0.00',
      status: 'settled',
    });
    expect(
      (
        await service.positions.read(f.actor, {
          invoiceId: purchase.invoice.id,
          date: '2026-10-31',
        })
      ).balance,
    ).toBe('81.00');
    await service.periods.close(f.actor, key(), '2026-11-01');
    const balances = Object.fromEntries(
      (await service.overview(f.actor)).balances.map((row) => [row.account, row.balance]),
    );
    expect(balances).toMatchObject({
      '5121': '901.20',
      '401': '0.00',
      '628': '100.00',
      '609': '-20.00',
      '4426': '16.80',
      '627': '2.00',
    });
    expect((await service.queries.movements(f.actor, { matched: false })).items).toHaveLength(0);
  });

  test('a later credit retains the 19 percent original tax rate after the August 2025 change', async () => {
    const f = await fixture(2025);
    const original = await invoice(f, {
      direction: 'sale',
      date: '2025-07-15',
      rate: '19',
      tax: '19.00',
      gross: '119.00',
    });
    const note = await credit(f, original, {
      date: '2025-08-05',
      net: '20.00',
      rate: '19',
      tax: '3.80',
      gross: '23.80',
    });
    const body = generalBodySchema.parse(note.proposal.body);
    expect(body.invoice).toMatchObject({
      tax: '3.80',
      taxPointDate: '2025-07-15',
      ruleId: 'ro-domestic-standard-2025-01',
    });
    expect(body.lines).toEqual([
      { account: '4111', debit: '0.00', credit: '23.80' },
      { account: '709', debit: '20.00', credit: '0.00' },
      { account: '4427', debit: '3.80', credit: '0.00' },
    ]);
    await approvePost(f, note.proposal);
    expect(
      (
        await service.positions.read(f.actor, {
          invoiceId: original.invoice.id,
          date: '2025-08-31',
        })
      ).balance,
    ).toBe('95.20');
    await expect(
      credit(f, original, {
        date: '2025-08-06',
        net: '10.00',
        rate: '21',
        tax: '2.10',
        gross: '12.10',
      }),
    ).rejects.toMatchObject({ code: 'CREDIT_VAT_RATE' });
  });

  test('paid sales can be reduced and refunded without inventing a second receivable', async () => {
    const f = await fixture();
    const sale = await invoice(f, { direction: 'sale' });
    const [receipt] = await statement(f, {
      rows: [{ id: 'RECEIPT', date: '2026-10-02', amount: '121.00' }],
      opening: '1000.00',
      closing: '1121.00',
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, receipt.id, sale.invoice.id, '121.00'),
      ),
    );
    const note = await credit(f, sale, {
      date: '2026-10-04',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    });
    await approvePost(f, note.proposal);
    expect(
      await service.positions.read(f.actor, { invoiceId: sale.invoice.id, date: '2026-10-04' }),
    ).toMatchObject({ balance: '-24.20', status: 'refund_due' });
    const [refund] = await statement(f, {
      rows: [{ id: 'REFUND', date: '2026-10-05', amount: '-24.20' }],
      opening: '1121.00',
      closing: '1096.80',
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, refund.id, sale.invoice.id, '-24.20'),
      ),
    );
    expect(
      await service.positions.read(f.actor, { invoiceId: sale.invoice.id, date: '2026-10-31' }),
    ).toMatchObject({ balance: '0.00', settled: '96.80', status: 'settled' });
    expect((await service.positions.list(f.actor, { date: '2026-10-31' })).items).toHaveLength(0);
    expect(
      (await service.positions.list(f.actor, { date: '2026-10-31', onlyOpen: false })).items,
    ).toHaveLength(1);
  });

  test('grouped receipts with fees and separate bank accounts retain every control balance', async () => {
    const f = await fixture();
    const a = await invoice(f, { direction: 'sale', number: 'S-1' }),
      b = await invoice(f, { direction: 'sale', number: 'S-2' });
    await service.treasury.createAccount(f.actor, key(), {
      identifier: 'RO00FIXTURE',
      kind: 'bank',
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
      evidenceId: f.proof.id,
    });
    await service.foundation.createAccount(f.actor, key(), {
      code: '5121.SECOND',
      parentCode: '5121',
      name: 'Cont bancar secundar',
      validFrom: '2026-01-01',
    });
    await service.treasury.createAccount(f.actor, key(), {
      identifier: 'RO00SECOND',
      kind: 'bank',
      currency: 'RON',
      ledgerAccount: '5121.SECOND',
      openedOn: '2026-10-01',
      evidenceId: f.proof.id,
    });
    const [receipt] = await statement(f, {
      account: 'RO00SECOND',
      rows: [{ id: 'GROUPED', date: '2026-10-15', amount: '240.00' }],
      opening: '0.00',
      closing: '240.00',
    });
    const proposal = await service.settlements.propose(f.actor, key(), {
      financialYearId: f.financialYear.id,
      movementId: receipt.id,
      allocations: [
        { invoiceId: a.invoice.id, amount: '121.00' },
        { invoiceId: b.invoice.id, amount: '121.00' },
      ],
      fee: { amount: '2.00', account: '627', evidenceId: f.proof.id },
    });
    await approvePost(f, proposal);
    const report = await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id });
    expect(report.balances.find((row) => row.account === '5121.SECOND')?.closing).toBe('240.00');
    expect(report.balances.find((row) => row.account === '5121')?.closing).toBe('1000.00');
    expect(report.balances.find((row) => row.account === '4111')?.closing).toBe('0.00');
    await expect(service.periods.close(f.actor, key(), '2026-10-01')).rejects.toMatchObject({
      code: 'STATEMENT_REQUIRED',
    });
    await statement(f, { rows: [], opening: '1000.00', closing: '1000.00' });
    await service.periods.close(f.actor, key(), '2026-10-01');
    expect((await service.treasury.accounts(f.actor)).items).toHaveLength(2);
  });

  test('cash receipts settle non-VAT invoices and close without a fabricated bank statement', async () => {
    const f = await fixture(2026, 'non_vat');
    // The opening bank balance still requires its real no-movement statement.
    await statement(f, { rows: [], opening: '1000.00', closing: '1000.00' });
    await service.treasury.createAccount(f.actor, key(), {
      identifier: 'CASA-RON',
      kind: 'cash',
      currency: 'RON',
      ledgerAccount: '5311',
      openedOn: '2026-10-01',
      evidenceId: f.proof.id,
    });
    const sale = await invoice(f, {
      direction: 'sale',
      category: 'O',
      tax: '0.00',
      gross: '100.00',
    });
    const receipt = await service.treasury.recordCashMovement(f.actor, key(), {
      account: 'CASA-RON',
      sourceId: 'CASH-1',
      date: '2026-10-02',
      amount: '100.00',
      reference: 'Chitanță pentru serviciile facturate',
      evidenceId: f.proof.id,
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, receipt.id, sale.invoice.id, '100.00'),
      ),
    );
    const purchase = await invoice(f, {
      number: 'P-1',
      date: '2026-10-03',
      category: 'O',
      tax: '0.00',
      gross: '100.00',
    });
    const cashOut = await service.treasury.recordCashMovement(f.actor, key(), {
      account: 'CASA-RON',
      sourceId: 'CASH-2',
      date: '2026-10-04',
      amount: '-100.00',
      reference: 'Plată documentată către furnizor',
      evidenceId: f.proof.id,
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, cashOut.id, purchase.invoice.id, '100.00'),
      ),
    );
    await service.periods.close(f.actor, key(), '2026-10-01');
    expect(
      (await service.overview(f.actor)).balances.find((row) => row.account === '5311')?.balance,
    ).toBe('0.00');
    expect((await service.queries.movements(f.actor, { matched: false })).items).toHaveLength(0);
  });

  test('legacy purchase matching uses its own analytical bank account and cannot post a duplicate payment', async () => {
    const f = await fixture(2026, 'non_vat');
    await statement(f, { rows: [], opening: '1000.00', closing: '1000.00' });
    await service.foundation.createAccount(f.actor, key(), {
      code: '5121.LEGACY',
      parentCode: '5121',
      name: 'Bancă pentru facturile anterioare',
      validFrom: '2026-01-01',
    });
    await service.treasury.createAccount(f.actor, key(), {
      identifier: 'RO00LEGACY',
      kind: 'bank',
      currency: 'RON',
      ledgerAccount: '5121.LEGACY',
      openedOn: '2026-01-01',
      evidenceId: f.proof.id,
    });
    await approvePost(
      f,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        evidenceId: f.proof.id,
        date: '2026-01-01',
        purpose: 'general',
        description: 'Aport documentat în contul secundar',
        sourceReference: 'additional-capital',
        lines: [
          { account: '5121.LEGACY', debit: '500.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '500.00' },
        ],
      }),
    );
    const proposal = await service.books.proposePurchase(f.actor, key(), {
      evidenceId: f.proof.id,
      supplier: 'Furnizor SRL',
      supplierCui: '87654321',
      invoiceNumber: 'LEGACY-1',
      date: '2026-10-01',
      serviceDate: '2026-10-01',
      amount: '100.00',
      description: 'Servicii documentate',
      supplierCountry: 'RO',
      currency: 'RON',
      vatTreatment: 'NON_VAT',
    });
    await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    await service.books.post(f.actor, key(), proposal.id, review(proposal));
    const [payment] = await statement(f, {
      account: 'RO00LEGACY',
      rows: [{ id: 'OLD-PAYMENT', date: '2026-10-10', amount: '-100.00' }],
      opening: '500.00',
      closing: '400.00',
    });
    await service.bank.match(f.actor, key(), {
      movementId: payment.id,
      proposalId: proposal.id,
      amount: '100.00',
    });
    const state = await service.overview(f.actor);
    expect(
      Object.fromEntries(state.balances.map((row) => [row.account, row.balance])),
    ).toMatchObject({ '5121': '1000.00', '5121.LEGACY': '400.00', '401': '0.00' });
    const entry = state.journals.find((row) => row.kind === 'payment')!;
    expect(entry.lines).toEqual([
      { account: '401', debit: '100.00', credit: '0.00' },
      { account: '5121.LEGACY', debit: '0.00', credit: '100.00' },
    ]);
    await expect(
      db.orm.transaction((tx) =>
        postJournal(tx, f.actor, {
          date: entry.date,
          kind: 'payment',
          sourceId: payment.id,
          evidenceId: entry.evidenceId,
          description: 'Tentativă de plată duplicată',
          lines: entry.lines,
        }),
      ),
    ).rejects.toThrow();
    await service.periods.close(f.actor, key(), '2026-10-01');
  });

  test('new credits invalidate approved settlements in the service and database guards', async () => {
    const f = await fixture(),
      purchase = await invoice(f);
    const [payment] = await statement(f, {
      rows: [{ id: 'STALE', date: '2026-10-15', amount: '-50.00' }],
      opening: '1000.00',
      closing: '950.00',
    });
    const input = allocation(f, payment.id, purchase.invoice.id, '50.00');
    const proposal = await service.settlements.propose(f.actor, key(), input);
    const approval = await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    const note = await credit(f, purchase, {
      date: '2026-10-10',
      net: '10.00',
      tax: '2.10',
      gross: '12.10',
    });
    await approvePost(f, note.proposal);
    await expect(
      service.ledger.post(f.actor, key(), { id: proposal.id, ...review(proposal) }),
    ).rejects.toMatchObject({ code: 'STALE_SETTLEMENT' });
    const body = generalBodySchema.parse(proposal.body);
    await expect(
      db.orm.transaction((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: proposal.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const revised = await service.settlements.propose(f.actor, key(), input, {
      id: proposal.id,
      version: proposal.version,
    });
    await approvePost(f, revised);
    expect(
      (
        await service.positions.read(f.actor, {
          invoiceId: purchase.invoice.id,
          date: '2026-10-31',
        })
      ).balance,
    ).toBe('58.90');
  });

  test('competing credits, over-allocation, wrong directions and backdated duplicates fail closed', async () => {
    const f = await fixture(),
      purchase = await invoice(f);
    const first = await credit(f, purchase, {
      date: '2026-10-05',
      net: '10.00',
      tax: '2.10',
      gross: '12.10',
    });
    const second = await credit(f, purchase, {
      date: '2026-10-06',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    });
    await service.books.approve(f.actor, key(), second.proposal.id, review(second.proposal));
    await approvePost(f, first.proposal);
    await expect(
      service.ledger.post(f.actor, key(), { id: second.proposal.id, ...review(second.proposal) }),
    ).rejects.toMatchObject({ code: 'STALE_CREDIT' });
    const refreshed = await service.invoices.proposeCreditNote(f.actor, key(), second.body, {
      id: second.proposal.id,
      version: second.proposal.version,
    });
    await approvePost(f, refreshed);
    await expect(
      credit(f, purchase, { date: '2026-10-07', net: '80.00', tax: '16.80', gross: '96.80' }),
    ).rejects.toMatchObject({ code: 'OVER_CREDIT' });
    const [full, prior, wrong] = await statement(f, {
      rows: [
        { id: 'FULL', date: '2026-10-20', amount: '-84.70' },
        { id: 'PRIOR', date: '2026-10-10', amount: '-1.00' },
        { id: 'WRONG', date: '2026-10-21', amount: '1.00' },
      ],
      opening: '1000.00',
      closing: '915.30',
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, full.id, purchase.invoice.id, '84.70'),
      ),
    );
    await expect(
      service.settlements.propose(
        f.actor,
        key(),
        allocation(f, prior.id, purchase.invoice.id, '1.00'),
      ),
    ).rejects.toMatchObject({ code: 'OVER_ALLOCATION' });
    await expect(
      service.settlements.propose(
        f.actor,
        key(),
        allocation(f, wrong.id, purchase.invoice.id, '-1.00'),
      ),
    ).rejects.toThrow();
  });

  test('direct mutation, cross-company inputs and agent approval bypasses are rejected', async () => {
    const f = await fixture(),
      other = await fixture(),
      purchase = await invoice(f);
    const [payment] = await statement(f, {
      rows: [{ id: 'SECURE', date: '2026-10-05', amount: '-100.00' }],
      opening: '1000.00',
      closing: '900.00',
    });
    await expect(
      service.settlements.propose(
        other.actor,
        key(),
        allocation(other, payment.id, purchase.invoice.id, '100.00'),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'Settlement agent',
      scopes: ['settlements.propose', 'positions.get', 'ledger.post'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const agent = { ...f.actor, agentId: grant.id };
    const proposal = await service.settlements.propose(
      agent,
      key(),
      allocation(f, payment.id, purchase.invoice.id, '100.00'),
    );
    await expect(
      service.books.approve(agent, key(), proposal.id, review(proposal)),
    ).rejects.toThrow();
    await expect(
      service.ledger.post(agent, key(), { id: proposal.id, ...review(proposal) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    const commandKey = key(),
      result = await service.ledger.post(agent, commandKey, {
        id: proposal.id,
        ...review(proposal),
      });
    expect(
      (await service.ledger.post(agent, commandKey, { id: proposal.id, ...review(proposal) })).id,
    ).toBe(result.id);
    await expect(
      db.orm.transaction((tx) =>
        postJournal(tx, f.actor, {
          date: payment.date,
          kind: 'payment',
          sourceId: payment.id,
          evidenceId: proposal.body.evidenceId,
          description: 'Tentativă de dublare prin fluxul anterior',
          lines: [
            { account: '401', debit: '100.00', credit: '0.00' },
            { account: '5121', debit: '0.00', credit: '100.00' },
          ],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.orm
        .delete(invoiceSettlements)
        .where(eq(invoiceSettlements.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(movementPostings)
        .set({ proposalId: key() })
        .where(eq(movementPostings.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    await service.agents.revoke(f.actor, key(), grant.id);
    await expect(
      service.ledger.post(agent, commandKey, { id: proposal.id, ...review(proposal) }),
    ).rejects.toThrow();
  });

  test('frozen exports and fresh restore retain credit links, invoice positions and settlement replay', async () => {
    const f = await fixture(),
      purchase = await invoice(f);
    const note = await credit(f, purchase, {
      date: '2026-10-02',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    });
    await approvePost(f, note.proposal);
    const [payment] = await statement(f, {
      rows: [{ id: 'RESTORE', date: '2026-10-05', amount: '-96.80' }],
      opening: '1000.00',
      closing: '903.20',
    });
    await approvePost(
      f,
      await service.settlements.propose(
        f.actor,
        key(),
        allocation(f, payment.id, purchase.invoice.id, '96.80'),
      ),
    );
    const expected = await service.positions.read(f.actor, {
      invoiceId: purchase.invoice.id,
      date: '2026-10-31',
    });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    );
    expect(exported.data.invoicePostings).toHaveLength(2);
    expect(exported.data.invoiceCredits).toHaveLength(1);
    expect(exported.data.invoiceSettlements).toHaveLength(1);
    await backup(db, objects, join(directory, 'native-backup'));
    const restored = await restore(
      join(directory, 'native-backup'),
      join(directory, 'native-restore'),
    );
    const copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.positions.read(f.actor, { invoiceId: purchase.invoice.id, date: '2026-10-31' }),
      ).toEqual(expected);
      expect((await copy.overview(f.actor)).movements.every((movement) => movement.matched)).toBe(
        true,
      );
      await expect(
        copyDb.orm
          .delete(invoiceCredits)
          .where(eq(invoiceCredits.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .delete(invoicePostings)
          .where(eq(invoicePostings.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(treasuryAccounts)
          .set({ ledgerAccount: '5121.OTHER' })
          .where(eq(treasuryAccounts.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      expect(
        await copyDb.orm
          .select()
          .from(journalLines)
          .where(eq(journalLines.companyId, f.company.id)),
      ).toEqual(
        await db.orm.select().from(journalLines).where(eq(journalLines.companyId, f.company.id)),
      );
    } finally {
      await copyDb.close();
    }
  });

  test('working VAT registers preserve the original rate, adjustment period and exact ledger reconciliation', async () => {
    const f = await fixture(2025);
    const sale = await invoice(f, {
      direction: 'sale',
      date: '2025-07-15',
      rate: '19',
      tax: '19.00',
      gross: '119.00',
    });
    await approvePost(
      f,
      (
        await credit(f, sale, {
          date: '2025-08-05',
          net: '20.00',
          rate: '19',
          tax: '3.80',
          gross: '23.80',
        })
      ).proposal,
    );
    await invoice(f, { direction: 'sale', number: 'AUG-SALE', date: '2025-08-10' });
    await invoice(f, { number: 'AUG-PURCHASE', date: '2025-08-10' });
    const input = { financialYearId: f.financialYear.id, from: '2025-08-01', to: '2025-08-31' };
    const summary = vatSummaryOutput.parse(
      await service.capabilities.invoke(f.actor, 'vat.summary', key(), input),
    );
    expect(summary).toMatchObject({
      officialDeclaration: false,
      status: 'reconciled',
      entryCount: 3,
      totals: { inputTax: '21.00', outputTax: '17.20' },
      reconciliation: {
        ledgerInputTax: '21.00',
        ledgerOutputTax: '17.20',
        inputDifference: '0.00',
        outputDifference: '0.00',
      },
      issues: [],
    });
    expect(summary.groups).toContainEqual({
      direction: 'sale',
      category: 'S',
      rate: '19',
      entryCount: 1,
      base: '-20.00',
      sourceTax: '-3.80',
      gross: '-23.80',
      inputTax: '0.00',
      outputTax: '-3.80',
    });
    const first = await service.vat.entries(f.actor, { ...input, limit: 1 });
    const second = await service.vat.entries(f.actor, {
      ...input,
      limit: 1,
      cursor: first.nextCursor,
    });
    const third = await service.vat.entries(f.actor, {
      ...input,
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.invoiceId)).size,
    ).toBe(3);
    expect(third.nextCursor).toBeNull();
    const adjustment = [...first.items, ...second.items, ...third.items].find(
      (row) => row.documentType === 'credit_note',
    )!;
    expect(adjustment).toMatchObject({
      originalInvoiceId: sale.invoice.id,
      recognitionDate: '2025-08-05',
      originalTaxPointDate: '2025-07-15',
      base: '-20.00',
    });
    expect((await service.vat.summary(f.actor, input)).hash).toBe(summary.hash);
    expect(
      (
        await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          from: '2025-07-01',
          to: '2025-07-31',
        })
      ).totals.outputTax,
    ).toBe('19.00');
  });

  test('non-VAT registers distinguish supplier VAT from deductible VAT and report unknown sources', async () => {
    const f = await fixture(2026, 'non_vat');
    await invoice(f);
    await invoice(f, { direction: 'sale', category: 'O', tax: '0.00', gross: '100.00' });
    const initial = await service.vat.summary(f.actor, { financialYearId: f.financialYear.id });
    expect(initial).toMatchObject({
      status: 'reconciled',
      totals: { sourceTax: '21.00', inputTax: '0.00', outputTax: '0.00' },
      issues: [],
    });
    const unknown = await importInvoice(f, { number: 'MISSING-TREATMENT' });
    const manual = await service.ledger.propose(f.actor, key(), {
      financialYearId: f.financialYear.id,
      evidenceId: f.proof.id,
      date: '2026-10-10',
      purpose: 'general',
      description: 'Ajustare TVA pentru verificarea diferenței',
      sourceReference: 'unclassified-vat',
      lines: [
        { account: '4426', debit: '1.00', credit: '0.00' },
        { account: '401', debit: '0.00', credit: '1.00' },
      ],
    });
    const { entry } = await approvePost(f, manual);
    const result = await service.vat.summary(f.actor, { financialYearId: f.financialYear.id });
    expect(result.status).toBe('needs_review');
    expect(result.reconciliation.inputDifference).toBe('1.00');
    expect(result.issues).toContainEqual({
      code: 'UNPOSTED_INVOICE',
      invoiceId: unknown.id,
      journalId: null,
    });
    expect(result.issues).toContainEqual({
      code: 'UNCLASSIFIED_JOURNAL',
      invoiceId: null,
      journalId: entry.id,
    });
    expect(result.issues).toContainEqual({
      code: 'INPUT_VAT_DIFFERENCE',
      invoiceId: null,
      journalId: null,
    });
    expect(result.hash).not.toBe(initial.hash);
    const other = await fixture();
    await expect(
      service.vat.summary(other.actor, { financialYearId: f.financialYear.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.vat.entries(f.actor, { financialYearId: f.financialYear.id, from: '2025-12-31' }),
    ).rejects.toMatchObject({ code: 'PERIOD_SCOPE' });
  });

  test('cross-year credits and receipts retain prior-year positions and exclude opening VAT from current registers', async () => {
    const f = await fixture(2025);
    const sale = await invoice(f, { direction: 'sale', date: '2025-12-20' });
    const financialYear = await service.foundation.createYear(f.actor, key(), {
      kind: 'financial',
      label: '2026',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const next = { ...f, financialYear };
    await approvePost(
      next,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: financialYear.id,
        evidenceId: f.proof.id,
        date: '2026-01-01',
        purpose: 'opening',
        description: 'Solduri de deschidere reconciliate',
        sourceReference: 'next-year-opening',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '4111', debit: '121.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
          { account: '4427', debit: '0.00', credit: '21.00' },
          { account: '1171', debit: '0.00', credit: '100.00' },
        ],
      }),
    );
    const note = await credit(next, sale, {
      date: '2026-01-15',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    });
    expect(
      generalBodySchema.parse(note.proposal.body).invoice?.credit?.originalFinancialYearId,
    ).toBe(f.financialYear.id);
    await approvePost(next, note.proposal);
    const [receipt] = await statement(next, {
      from: '2026-01-01',
      to: '2026-01-31',
      rows: [{ id: 'NEXT-RECEIPT', date: '2026-01-20', amount: '96.80' }],
      opening: '1000.00',
      closing: '1096.80',
    });
    await approvePost(
      next,
      await service.settlements.propose(
        next.actor,
        key(),
        allocation(next, receipt.id, sale.invoice.id, '96.80'),
      ),
    );
    expect(
      (await service.positions.read(f.actor, { invoiceId: sale.invoice.id, date: '2025-12-31' }))
        .balance,
    ).toBe('121.00');
    expect(
      (await service.positions.read(f.actor, { invoiceId: sale.invoice.id, date: '2026-01-31' }))
        .balance,
    ).toBe('0.00');
    expect(await service.vat.summary(f.actor, { financialYearId: financialYear.id })).toMatchObject(
      {
        status: 'reconciled',
        entryCount: 1,
        totals: { outputTax: '-4.20' },
        reconciliation: { ledgerOutputTax: '-4.20', outputDifference: '0.00' },
      },
    );
    expect(
      (
        await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id })
      ).balances.find((row) => row.account === '4111')?.closing,
    ).toBe('121.00');
    await service.periods.close(next.actor, key(), '2026-01-01');
  });

  test('cash cannot go negative and retained cash source identities cannot change', async () => {
    const f = await fixture(2026, 'non_vat');
    await service.treasury.createAccount(f.actor, key(), {
      identifier: 'CASH-GUARD',
      kind: 'cash',
      currency: 'RON',
      ledgerAccount: '5311',
      openedOn: '2026-01-01',
      evidenceId: f.proof.id,
    });
    const purchase = await invoice(f, { category: 'O', tax: '0.00', gross: '100.00' });
    const input = {
      account: 'CASH-GUARD',
      sourceId: 'FIXED-RECEIPT',
      date: '2026-10-02',
      amount: '-100.00',
      reference: 'Document de plată numerar',
      evidenceId: f.proof.id,
    };
    const movement = await service.treasury.recordCashMovement(f.actor, key(), input);
    expect((await service.treasury.recordCashMovement(f.actor, key(), input)).id).toBe(movement.id);
    await expect(
      service.treasury.recordCashMovement(f.actor, key(), { ...input, amount: '-99.00' }),
    ).rejects.toMatchObject({ code: 'MOVEMENT_CONFLICT' });
    await expect(
      service.settlements.propose(
        f.actor,
        key(),
        allocation(f, movement.id, purchase.invoice.id, '100.00'),
      ),
    ).rejects.toMatchObject({ code: 'NEGATIVE_CASH' });
  });

  test('a narrowly scoped MCP client prepares credits and settlements, pauses for approval and reads tax reconciliation', async () => {
    const f = await fixture(),
      purchase = await invoice(f);
    const document = await importInvoice(f, {
      credit: true,
      originalNumber: purchase.invoice.body.number,
      number: 'MCP-CREDIT',
      date: '2026-10-02',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    });
    const [payment] = await statement(f, {
      rows: [{ id: 'MCP-PAYMENT', date: '2026-10-10', amount: '-96.80' }],
      opening: '1000.00',
      closing: '903.20',
    });
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'MCP settlement accountant',
      scopes: [
        'invoices.proposeCreditNote',
        'settlements.propose',
        'positions.get',
        'vat.summary',
        'ledger.post',
      ],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app;
    const client = new Client(
      { name: 'xfactura-settlement-contract-test', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${publicUrl}/api/accounting/v1/companies/${f.company.id}/mcp`),
        {
          authProvider: { token: async () => grant.token },
          fetch: async (url, init) => {
            const request = new Request(url, init);
            request.headers.set('host', new URL(request.url).host);
            return app.fetch(request);
          },
        },
      ),
    );
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).not.toContain('books.approve');
      expect(tools).not.toContain('ledger.propose');
      const prepared = await client.callTool({
        name: 'invoices.proposeCreditNote',
        arguments: {
          idempotencyKey: key(),
          input: {
            invoiceId: document.id,
            originalInvoiceId: purchase.invoice.id,
            financialYearId: f.financialYear.id,
            recognitionDate: '2026-10-02',
            decisionDate: '2026-10-02',
            treatmentEvidenceId: f.proof.id,
            kind: 'commercial_discount',
            periodBasis: 'current_period_event',
            reason: 'Reducere comercială documentată prin acord ulterior',
          },
        },
      });
      const note = proposalOutput.parse(prepared.structuredContent);
      const denied = await client.callTool({
        name: 'ledger.post',
        arguments: { idempotencyKey: key(), input: { id: note.id, ...review(note) } },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), note.id, review(note));
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { idempotencyKey: key(), input: { id: note.id, ...review(note) } },
          })
        ).isError,
      ).not.toBe(true);
      const preparedPayment = await client.callTool({
        name: 'settlements.propose',
        arguments: {
          idempotencyKey: key(),
          input: allocation(f, payment.id, purchase.invoice.id, '96.80'),
        },
      });
      const proposal = proposalOutput.parse(preparedPayment.structuredContent);
      await service.books.approve(f.actor, key(), proposal.id, review(proposal));
      const commandKey = key(),
        args = { idempotencyKey: commandKey, input: { id: proposal.id, ...review(proposal) } };
      const posted = postingOutput.parse(
        (await client.callTool({ name: 'ledger.post', arguments: args })).structuredContent,
      );
      expect(
        postingOutput.parse(
          (await client.callTool({ name: 'ledger.post', arguments: args })).structuredContent,
        ),
      ).toEqual(posted);
      expect(
        positionOutput.parse(
          (
            await client.callTool({
              name: 'positions.get',
              arguments: { input: { invoiceId: purchase.invoice.id, date: '2026-10-31' } },
            })
          ).structuredContent,
        ).balance,
      ).toBe('0.00');
      const summary = await client.callTool({
        name: 'vat.summary',
        arguments: { input: { financialYearId: f.financialYear.id } },
      });
      expect(vatSummaryOutput.parse(summary.structuredContent)).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: '16.80' },
        officialDeclaration: false,
      });
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(client.callTool({ name: 'ledger.post', arguments: args })).rejects.toThrow(
        'Unauthorized',
      );
    } finally {
      await client.close();
    }
  });
});
