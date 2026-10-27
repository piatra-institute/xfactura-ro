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
  accrualPositionOutput,
  proposalOutput,
} from '../../source/accounting/capability-contracts';
import { LocalObjectStore } from '../../source/accounting/object-store';
import {
  generalBodySchema,
  type AccrualInput,
  type AccrualInvoiceInput,
} from '../../source/accounting/domain';
import { accrualMatches, accrualPostings, journalLines } from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID();
const review = (proposal: { version: number; hash: string }) => ({
  version: proposal.version,
  hash: proposal.hash,
});
const secret = 'synthetic-accrual-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-accruals-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  const owner = await createAuth(
    db,
    { publicUrl: 'http://localhost:3000', authSecret: secret },
    true,
  ).api.signUpEmail({
    body: {
      name: 'Accrual reviewer',
      email: 'accruals@example.test',
      password: 'synthetic-accrual-password',
    },
  });
  ownerId = owner.user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function source(actor: Actor, filename: string, contents: string) {
  return service.documents.record(actor, key(), {
    filename,
    mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
    bytes: Buffer.from(contents),
  });
}
async function post(
  actor: Actor,
  proposal: { id: string; version: number; hash: string },
  commandKey = key(),
) {
  const approval = await service.books.approve(actor, key(), proposal.id, review(proposal));
  return {
    entry: await service.ledger.post(actor, commandKey, { id: proposal.id, ...review(proposal) }),
    approval,
  };
}
async function fixture(vat: 'normal_vat' | 'non_vat' = 'normal_vat', year = 2026) {
  const company = await service.companies.create(ownerId, key(), {
    name: 'Accrual fixture SRL',
    cui: '12345678',
    year,
  });
  const actor = { companyId: company.id, actorId: ownerId },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!;
  const proof = await source(
    actor,
    'service-acceptance.txt',
    `Retained independent evidence of completed services: ${company.id}`,
  );
  const receipt = await source(
    actor,
    'invoice-received.txt',
    `Retained dated receipt evidence: ${company.id}`,
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
  await post(
    actor,
    await service.ledger.propose(actor, key(), {
      financialYearId: financialYear.id,
      evidenceId: proof.id,
      date: financialYear.from,
      purpose: 'opening',
      description: 'Solduri inițiale documentate',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '5000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '5000.00' },
      ],
    }),
  );
  return { actor, company, financialYear, proof, receipt, vat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture, override: Partial<AccrualInput> = {}): AccrualInput {
  return {
    financialYearId: f.financialYear.id,
    evidenceId: f.proof.id,
    evidenceDate: '2026-01-31',
    reference: key(),
    date: '2026-01-31',
    serviceFrom: '2026-01-01',
    serviceTo: '2026-01-31',
    supplier: { name: 'Companie 87654321', taxId: '87654321', country: 'RO' },
    currency: 'RON',
    account: '628',
    net: '100.00',
    vatCategory: 'S',
    taxPointDate: '2026-01-31',
    deduction: f.vat === 'normal_vat' ? 'full' : 'none',
    counterpartyVatCollection: 'no',
    reason: 'Servicii efectuate și acceptate, documentate înainte de primirea facturii',
    ...override,
  };
}
async function accrue(f: Fixture, override: Partial<AccrualInput> = {}) {
  const body = input(f, override),
    proposal = await service.accruals.propose(f.actor, key(), body),
    posted = await post(f.actor, proposal);
  return { body, proposal, ...posted };
}
async function imported(f: Fixture, override: XmlInput = {}) {
  const xml = await source(
    f.actor,
    `${key()}.xml`,
    invoiceXml({ number: key(), date: '2026-02-03', taxPointDate: '2026-01-31', ...override }),
  );
  return service.invoices.import(f.actor, key(), { evidenceId: xml.id });
}
function matchInput(
  f: Fixture,
  invoiceId: string,
  allocations: AccrualInvoiceInput['allocations'],
): AccrualInvoiceInput {
  return {
    financialYearId: f.financialYear.id,
    invoiceId,
    recognitionDate: '2026-02-10',
    receivedDate: '2026-02-10',
    receiptEvidenceId: f.receipt.id,
    allocations,
  };
}
async function statement(
  f: Fixture,
  from: string,
  to: string,
  opening: string,
  closing: string,
  rows = '',
) {
  const proof = await source(
    f.actor,
    `${key()}.csv`,
    `movement_id,booking_date,amount,currency,reference\n${rows}`,
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: proof.id,
    bankAccount: 'RO00ACCRUAL',
    statementId: key(),
    from,
    to,
    opening,
    closing,
  });
}
async function balances(f: Fixture) {
  return Object.fromEntries(
    (await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id })).balances.map(
      (row) => [row.account, row.closing],
    ),
  );
}

describe('evidenced purchase accruals and later invoice matching', () => {
  test('amounts beyond floating-point precision match independent bani arithmetic', async () => {
    const f = await fixture(),
      net = 9007199254740993n,
      tax = (net * 21n + 50n) / 100n;
    const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
    const original = await accrue(f, { net: decimal(net) });
    expect(
      await service.accruals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-01-31',
      }),
    ).toMatchObject({
      status: 'reconciled',
      liability: { unbilled: decimal(net + tax) },
      vatAwaitingInvoice: { unbilled: decimal(tax) },
    });
    expect(generalBodySchema.parse(original.proposal.body).accrual?.tax).toBe(decimal(tax));
    const invoice = await imported(f, {
      net: decimal(net),
      tax: decimal(tax),
      gross: decimal(net + tax),
    });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matchInput(f, invoice.id, [
          { accrualId: original.proposal.id, net: decimal(net), tax: decimal(tax) },
        ]),
      ),
    );
    expect(await balances(f)).toMatchObject({
      '628': decimal(net),
      '408': '0.00',
      '4428': '0.00',
      '4426': decimal(tax),
      '401': `-${decimal(net + tax)}`,
    });
  });
  test('a December VAT expense closes, then a February invoice clears the carried liability without another expense', async () => {
    const f = await fixture('normal_vat', 2025);
    const original = await accrue(f, {
      date: '2025-12-31',
      evidenceDate: '2025-12-31',
      serviceFrom: '2025-12-01',
      serviceTo: '2025-12-31',
      taxPointDate: '2025-12-31',
      net: '2000.00',
    });
    expect(generalBodySchema.parse(original.proposal.body).lines).toEqual([
      { account: '628', debit: '2000.00', credit: '0.00' },
      { account: '408', debit: '0.00', credit: '2420.00' },
      { account: '4428', debit: '420.00', credit: '0.00' },
    ]);
    await statement(f, '2025-12-01', '2025-12-31', '5000.00', '5000.00');
    await service.periods.close(f.actor, key(), '2025-12-01');
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00' } });
    const financialYear = await service.foundation.createYear(f.actor, key(), {
        kind: 'financial',
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      }),
      next = { ...f, financialYear };
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: financialYear.id,
        evidenceId: f.proof.id,
        date: '2026-01-01',
        purpose: 'opening',
        description: 'Solduri reportate și reconciliate',
        sourceReference: 'opening-2026',
        lines: [
          { account: '5121', debit: '5000.00', credit: '0.00' },
          { account: '4428', debit: '420.00', credit: '0.00' },
          { account: '1171', debit: '2000.00', credit: '0.00' },
          { account: '408', debit: '0.00', credit: '2420.00' },
          { account: '1012', debit: '0.00', credit: '5000.00' },
        ],
      }),
    );
    const invoice = await imported(next, {
      taxPointDate: '2025-12-31',
      net: '2000.00',
      tax: '420.00',
      gross: '2420.00',
    });
    const body = matchInput(next, invoice.id, [
      { accrualId: original.proposal.id, net: '2000.00', tax: '420.00' },
    ]);
    const proposal = await service.accruals.matchInvoice(f.actor, key(), body),
      commandKey = key();
    expect(generalBodySchema.parse(proposal.body).lines).toEqual([
      { account: '408', debit: '2420.00', credit: '0.00' },
      { account: '401', debit: '0.00', credit: '2420.00' },
      { account: '4426', debit: '420.00', credit: '0.00' },
      { account: '4428', debit: '0.00', credit: '420.00' },
    ]);
    const { entry } = await post(f.actor, proposal, commandKey);
    expect(
      (await service.ledger.post(f.actor, commandKey, { id: proposal.id, ...review(proposal) })).id,
    ).toBe(entry.id);
    expect(await balances(f)).toMatchObject({
      '628': '2000.00',
      '408': '-2420.00',
      '4428': '420.00',
    });
    expect(await balances(next)).toMatchObject({
      '408': '0.00',
      '4428': '0.00',
      '4426': '420.00',
      '401': '-2420.00',
    });
    expect((await balances(next))['628']).toBeUndefined();
    expect(
      await service.accruals.get(f.actor, { id: original.proposal.id, date: '2025-12-31' }),
    ).toMatchObject({ remainingGross: '2420.00', remainingDeferredTax: '420.00' });
    expect(
      await service.accruals.get(f.actor, { id: original.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({ remainingGross: '0.00', remainingDeferredTax: '0.00', status: 'matched' });
    expect(
      await service.vat.summary(f.actor, {
        financialYearId: financialYear.id,
        from: '2026-02-01',
        to: '2026-02-28',
      }),
    ).toMatchObject({
      status: 'reconciled',
      totals: { inputTax: '420.00' },
      reconciliation: { inputDifference: '0.00' },
    });
    await statement(
      next,
      '2026-02-01',
      '2026-02-28',
      '5000.00',
      '2580.00',
      'PAY,2026-02-15,-2420.00,RON,Factura achitata\n',
    );
    const movement = (await service.queries.movements(f.actor, { matched: false })).items[0];
    await post(
      f.actor,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: financialYear.id,
        movementId: movement.id,
        allocations: [{ invoiceId: invoice.id, amount: '2420.00' }],
      }),
    );
    await service.periods.close(f.actor, key(), '2026-02-01');
    expect((await balances(next))['5121']).toBe('2580.00');
    expect(
      (await service.positions.read(f.actor, { invoiceId: invoice.id, date: '2026-02-28' }))
        .balance,
    ).toBe('0.00');
  });

  test('missing year-opening continuity is visible in control reconciliation and blocks monthly close', async () => {
    const f = await fixture('normal_vat', 2025);
    const original = await accrue(f, {
      date: '2025-12-31',
      evidenceDate: '2025-12-31',
      serviceFrom: '2025-12-01',
      serviceTo: '2025-12-31',
      taxPointDate: '2025-12-31',
    });
    const financialYear = await service.foundation.createYear(f.actor, key(), {
        kind: 'financial',
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      }),
      next = { ...f, financialYear };
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: financialYear.id,
        evidenceId: f.proof.id,
        date: '2026-01-01',
        purpose: 'opening',
        description: 'Poziție de deschidere incompletă pentru verificare',
        sourceReference: 'incomplete-opening',
        lines: [
          { account: '5121', debit: '5000.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '5000.00' },
        ],
      }),
    );
    const invoice = await imported(next, { taxPointDate: '2025-12-31' });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matchInput(next, invoice.id, [
          { accrualId: original.proposal.id, net: '100.00', tax: '21.00' },
        ]),
      ),
    );
    expect(
      await service.capabilities.invoke(f.actor, 'accruals.reconcile', '', {
        financialYearId: financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({
      status: 'needs_review',
      liability: { ledger: '-121.00', unbilled: '0.00', difference: '-121.00' },
      vatAwaitingInvoice: { ledger: '-21.00', unbilled: '0.00', difference: '-21.00' },
    });
    await statement(next, '2026-02-01', '2026-02-28', '5000.00', '5000.00');
    await expect(service.periods.close(f.actor, key(), '2026-02-01')).rejects.toMatchObject({
      code: 'ACCRUAL_CONTROL_DIFFERENCE',
    });
  });

  test.each([
    { vat: 'non_vat' as const, category: 'O' as const, tax: '0.00', gross: '100.00' },
    { vat: 'non_vat' as const, category: 'S' as const, tax: '21.00', gross: '121.00' },
    { vat: 'normal_vat' as const, category: 'S' as const, tax: '21.00', gross: '121.00' },
  ])(
    'no-deduction purchases retain supplier VAT as original-period cost: $vat / $category',
    async ({ vat, category, tax, gross }) => {
      const f = await fixture(vat),
        original = await accrue(f, { vatCategory: category, deduction: 'none' });
      const invoice = await imported(f, { category, tax, gross });
      await post(
        f.actor,
        await service.accruals.matchInvoice(
          f.actor,
          key(),
          matchInput(f, invoice.id, [{ accrualId: original.proposal.id, net: '100.00', tax }]),
        ),
      );
      expect(await balances(f)).toMatchObject({ '628': gross, '408': '0.00', '401': `-${gross}` });
      expect((await balances(f))['4426']).toBeUndefined();
      expect((await balances(f))['4428']).toBeUndefined();
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00' } });
    },
  );

  test('partial and grouped matches preserve independent open balances and bounded dated pages', async () => {
    const f = await fixture(),
      a = await accrue(f),
      b = await accrue(f, { net: '200.00' });
    const first = await imported(f, { net: '40.00', tax: '8.40', gross: '48.40' });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matchInput(f, first.id, [{ accrualId: a.proposal.id, net: '40.00', tax: '8.40' }]),
      ),
    );
    expect(
      await service.accruals.get(f.actor, { id: a.proposal.id, date: '2026-02-10' }),
    ).toMatchObject({ remainingNet: '60.00', remainingTax: '12.60', remainingGross: '72.60' });
    const page = await service.accruals.list(f.actor, { date: '2026-02-10', limit: 1 }),
      second = await service.accruals.list(f.actor, {
        date: '2026-02-10',
        limit: 1,
        cursor: page.nextCursor,
      });
    expect(new Set([...page.items, ...second.items].map((row) => row.id)).size).toBe(2);
    expect(second.nextCursor).toBeNull();
    const last = await imported(f, { net: '260.00', tax: '54.60', gross: '314.60' });
    await post(
      f.actor,
      await service.accruals.matchInvoice(f.actor, key(), {
        ...matchInput(f, last.id, [
          { accrualId: a.proposal.id, net: '60.00', tax: '12.60' },
          { accrualId: b.proposal.id, net: '200.00', tax: '42.00' },
        ]),
        recognitionDate: '2026-02-15',
        receivedDate: '2026-02-15',
      }),
    );
    expect((await service.accruals.list(f.actor, { date: '2026-02-28' })).items).toHaveLength(0);
    expect((await service.accruals.list(f.actor, { date: '2026-01-31' })).items).toHaveLength(2);
    expect(await balances(f)).toMatchObject({
      '628': '300.00',
      '408': '0.00',
      '4428': '0.00',
      '4426': '63.00',
      '401': '-363.00',
    });
  });

  test('competing matches invalidate exact approval in the service and database, then require a fresh review', async () => {
    const f = await fixture(),
      original = await accrue(f);
    const a = await imported(f, { net: '40.00', tax: '8.40', gross: '48.40' }),
      b = await imported(f, { net: '20.00', tax: '4.20', gross: '24.20' });
    const inputA = matchInput(f, a.id, [
        { accrualId: original.proposal.id, net: '40.00', tax: '8.40' },
      ]),
      inputB = matchInput(f, b.id, [
        { accrualId: original.proposal.id, net: '20.00', tax: '4.20' },
      ]);
    const proposalA = await service.accruals.matchInvoice(f.actor, key(), inputA),
      proposalB = await service.accruals.matchInvoice(f.actor, key(), inputB);
    const approval = await service.books.approve(f.actor, key(), proposalB.id, review(proposalB));
    await post(f.actor, proposalA);
    await expect(
      service.ledger.post(f.actor, key(), { id: proposalB.id, ...review(proposalB) }),
    ).rejects.toMatchObject({ code: 'STALE_ACCRUAL_MATCH' });
    const body = generalBodySchema.parse(proposalB.body);
    await expect(
      db.orm.transaction((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: proposalB.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const refreshed = await service.accruals.matchInvoice(f.actor, key(), inputB, {
      id: proposalB.id,
      version: proposalB.version,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: refreshed.id, ...review(refreshed) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, refreshed);
    expect(
      (await service.accruals.get(f.actor, { id: original.proposal.id, date: '2026-02-28' }))
        .remainingGross,
    ).toBe('48.40');
    await expect(service.accruals.matchInvoice(f.actor, key(), inputA)).rejects.toMatchObject({
      code: 'INVOICE_ALREADY_POSTED',
    });
    const excessive = await imported(f, { net: '50.00', tax: '10.50', gross: '60.50' });
    await expect(
      service.accruals.matchInvoice(
        f.actor,
        key(),
        matchInput(f, excessive.id, [
          { accrualId: original.proposal.id, net: '50.00', tax: '10.50' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'ACCRUAL_OVER_MATCH' });
  });

  test('a late invoice retains the original 19 percent rate, and a later credit does not consume the accrual twice', async () => {
    const f = await fixture('normal_vat', 2025),
      original = await accrue(f, {
        date: '2025-07-31',
        evidenceDate: '2025-07-31',
        serviceFrom: '2025-07-01',
        serviceTo: '2025-07-31',
        taxPointDate: '2025-07-31',
      });
    const invoice = await imported(f, {
      date: '2025-08-03',
      taxPointDate: '2025-07-31',
      rate: '19',
      tax: '19.00',
      gross: '119.00',
    });
    const prepared = await service.accruals.matchInvoice(f.actor, key(), {
      ...matchInput(f, invoice.id, [
        { accrualId: original.proposal.id, net: '100.00', tax: '19.00' },
      ]),
      recognitionDate: '2025-08-10',
      receivedDate: '2025-08-10',
    });
    await post(f.actor, prepared);
    const note = await imported(f, {
      credit: true,
      originalNumber: invoice.body.number,
      date: '2025-08-15',
      taxPointDate: undefined,
      net: '20.00',
      rate: '19',
      tax: '3.80',
      gross: '23.80',
    });
    const proposal = await service.invoices.proposeCreditNote(f.actor, key(), {
      invoiceId: note.id,
      originalInvoiceId: invoice.id,
      financialYearId: f.financialYear.id,
      recognitionDate: '2025-08-15',
      decisionDate: '2025-08-15',
      treatmentEvidenceId: f.proof.id,
      kind: 'commercial_discount',
      periodBasis: 'current_period_event',
      reason: 'Reducere comercială negociată după primirea facturii',
    });
    expect(generalBodySchema.parse(proposal.body).invoice?.accrualMatch).toBeUndefined();
    await post(f.actor, proposal);
    expect(
      await db.orm.select().from(accrualMatches).where(eq(accrualMatches.companyId, f.company.id)),
    ).toHaveLength(1);
    expect(
      (await service.accruals.get(f.actor, { id: original.proposal.id, date: '2025-08-31' }))
        .remainingGross,
    ).toBe('0.00');
    expect(
      await service.vat.summary(f.actor, {
        financialYearId: f.financialYear.id,
        from: '2025-08-01',
        to: '2025-08-31',
      }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '15.20' } });
  });

  test('missing or later evidence, over-matching, wrong source and registration transitions fail closed', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      service.accruals.propose(f.actor, key(), {
        ...input(f),
        supplier: { name: f.company.name, taxId: f.company.cui, country: 'RO' },
      }),
    ).rejects.toMatchObject({ code: 'ACCRUAL_SUPPLIER' });
    await expect(
      service.accruals.propose(f.actor, key(), { ...input(f), evidenceDate: '2026-02-01' }),
    ).rejects.toMatchObject({ code: 'ACCRUAL_PERIOD' });
    await expect(
      service.accruals.propose(f.actor, key(), { ...input(f), evidenceId: other.proof.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const later = await imported(f);
    await expect(
      service.accruals.propose(f.actor, key(), { ...input(f), evidenceId: later.evidenceId }),
    ).rejects.toMatchObject({ code: 'ACCRUAL_EVIDENCE' });
    const original = await accrue(f),
      wrong = await imported(f, { direction: 'sale' });
    await expect(
      service.accruals.matchInvoice(
        f.actor,
        key(),
        matchInput(f, wrong.id, [{ accrualId: original.proposal.id, net: '100.00', tax: '21.00' }]),
      ),
    ).rejects.toMatchObject({ code: 'ACCRUAL_INVOICE_SCOPE' });
    await expect(
      service.accruals.matchInvoice(
        other.actor,
        key(),
        matchInput(other, later.id, [
          { accrualId: original.proposal.id, net: '100.00', tax: '21.00' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.accruals.matchInvoice(
        f.actor,
        key(),
        matchInput(f, later.id, [{ accrualId: original.proposal.id, net: '101.00', tax: '21.21' }]),
      ),
    ).rejects.toMatchObject({ code: 'ACCRUAL_OVER_MATCH' });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'non_vat',
      effectiveFrom: '2026-02-01',
      evidenceId: f.receipt.id,
    });
    await expect(
      service.accruals.matchInvoice(
        f.actor,
        key(),
        matchInput(f, later.id, [{ accrualId: original.proposal.id, net: '100.00', tax: '21.00' }]),
      ),
    ).rejects.toMatchObject({ code: 'ACCRUAL_VAT_TRANSITION' });
  });

  test('revision, company scopes, immutable links, export and fresh restore preserve exact accounting', async () => {
    const f = await fixture(),
      body = input(f),
      draft = await service.accruals.propose(f.actor, key(), body);
    await service.books.approve(f.actor, key(), draft.id, review(draft));
    const changed = await service.accruals.propose(
      f.actor,
      key(),
      { ...body, net: '200.00' },
      { id: draft.id, version: draft.version },
    );
    await expect(
      service.ledger.post(f.actor, key(), { id: draft.id, ...review(draft) }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await post(f.actor, changed);
    const invoice = await imported(f, { net: '200.00', tax: '42.00', gross: '242.00' });
    const grant = await service.agents.issue(f.actor, key(), {
        name: 'Accrual worker',
        scopes: ['accruals.matchInvoice', 'accruals.get', 'ledger.post'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      agent = { ...f.actor, agentId: grant.id };
    const proposal = await service.accruals.matchInvoice(
      agent,
      key(),
      matchInput(f, invoice.id, [{ accrualId: draft.id, net: '200.00', tax: '42.00' }]),
    );
    await expect(
      service.books.approve(agent, key(), proposal.id, review(proposal)),
    ).rejects.toThrow();
    await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    const commandKey = key(),
      posted = await service.ledger.post(agent, commandKey, {
        id: proposal.id,
        ...review(proposal),
      });
    const expected = await service.accruals.get(f.actor, { id: draft.id, date: '2026-02-28' });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const data = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(data.accrualPostings).toHaveLength(1);
    expect(data.accrualMatches).toHaveLength(1);
    await backup(db, objects, join(directory, 'accrual-backup'));
    const restored = await restore(
        join(directory, 'accrual-backup'),
        join(directory, 'accrual-restore'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.accruals.get(f.actor, { id: draft.id, date: '2026-02-28' })).toEqual(
        expected,
      );
      expect(
        await copy.ledger.post(agent, commandKey, { id: proposal.id, ...review(proposal) }),
      ).toEqual(posted);
      expect(
        await copyDb.orm
          .select()
          .from(journalLines)
          .where(eq(journalLines.companyId, f.company.id)),
      ).toEqual(
        await db.orm.select().from(journalLines).where(eq(journalLines.companyId, f.company.id)),
      );
      await expect(
        copyDb.orm
          .delete(accrualPostings)
          .where(eq(accrualPostings.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(accrualMatches)
          .set({ netBani: 0n })
          .where(eq(accrualMatches.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await copy.agents.revoke(f.actor, key(), grant.id);
      await expect(
        copy.ledger.post(agent, commandKey, { id: proposal.id, ...review(proposal) }),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });

  test('scoped MCP prepares accruals and later matches, pauses for human approval and loses authority on revocation', async () => {
    const f = await fixture();
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'MCP accrual accountant',
      scopes: ['accruals.propose', 'accruals.matchInvoice', 'accruals.get', 'ledger.post'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app;
    const client = new Client(
      { name: 'xfactura-accrual-contract', version: '1' },
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
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('accruals.propose');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('ledger.propose');
      const original = proposalOutput.parse(
        (
          await client.callTool({
            name: 'accruals.propose',
            arguments: { input: input(f), idempotencyKey: key() },
          })
        ).structuredContent,
      );
      const posting = { input: { id: original.id, ...review(original) }, idempotencyKey: key() };
      const denied = await client.callTool({ name: 'ledger.post', arguments: posting });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), original.id, review(original));
      expect((await client.callTool({ name: 'ledger.post', arguments: posting })).isError).not.toBe(
        true,
      );
      const invoice = await imported(f);
      const matched = proposalOutput.parse(
        (
          await client.callTool({
            name: 'accruals.matchInvoice',
            arguments: {
              input: matchInput(f, invoice.id, [
                { accrualId: original.id, net: '100.00', tax: '21.00' },
              ]),
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      );
      expect(
        generalBodySchema.parse(matched.body).lines.some((line) => line.account === '628'),
      ).toBe(false);
      await service.books.approve(f.actor, key(), matched.id, review(matched));
      const exact = { input: { id: matched.id, ...review(matched) }, idempotencyKey: key() };
      const posted = await client.callTool({ name: 'ledger.post', arguments: exact });
      expect(
        (await client.callTool({ name: 'ledger.post', arguments: exact })).structuredContent,
      ).toEqual(posted.structuredContent);
      expect(
        accrualPositionOutput.parse(
          (
            await client.callTool({
              name: 'accruals.get',
              arguments: { input: { id: original.id, date: '2026-02-28' } },
            })
          ).structuredContent,
        ),
      ).toMatchObject({ status: 'matched', remainingGross: '0.00' });
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(client.callTool({ name: 'ledger.post', arguments: exact })).rejects.toThrow(
        'Unauthorized',
      );
    } finally {
      await client.close();
    }
  });
});
