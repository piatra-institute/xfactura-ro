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
import { proposalOutput, advancePaymentOutput } from '../../source/accounting/capability-contracts';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import {
  generalBodySchema,
  canonical,
  type AdvanceInvoiceInput,
  type AdvancePaymentInput,
  type AdvanceFinalInput,
} from '../../source/accounting/domain';
import {
  advancePayments,
  advanceInvoices,
  advanceInvoiceMatches,
  advanceUses,
  advanceRefunds,
  facts,
  proposals,
  journalLines,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { finalInvoiceXml } from './fixtures/advance';
const key = () => randomUUID(),
  review = (p: { version: number; hash: string }) => ({ version: p.version, hash: p.hash }),
  secret = 'synthetic-advance-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-advances-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  ownerId = (
    await createAuth(
      db,
      { publicUrl: 'http://localhost:3000', authSecret: secret },
      true,
    ).api.signUpEmail({
      body: {
        name: 'Advance reviewer',
        email: 'advances@example.test',
        password: 'synthetic-advance-password',
      },
    })
  ).user.id;
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
  p: { id: string; version: number; hash: string },
  commandKey = key(),
) {
  const approval = await service.books.approve(actor, key(), p.id, review(p)),
    entry = await service.ledger.post(actor, commandKey, { id: p.id, ...review(p) });
  expect(await service.ledger.post(actor, commandKey, { id: p.id, ...review(p) })).toEqual(entry);
  return { entry, approval };
}
async function fixture(
  vat: 'normal_vat' | 'non_vat' = 'normal_vat',
  year = 2026,
  opening = '1000.00',
) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Advance fixture SRL',
      cui: '12345678',
      year,
    }),
    actor = { companyId: company.id, actorId: ownerId },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(actor, 'contract.txt', `Documented future services for ${company.id}`);
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
      description: 'Documented opening',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: opening, credit: '0.00' },
        { account: '1012', debit: '0.00', credit: opening },
      ],
    }),
  );
  return { actor, company, financialYear, proof, vat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
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
    bankAccount: 'RO00ADVANCES',
    statementId: key(),
    from,
    to,
    opening,
    closing,
  });
}
function paymentInput(
  f: Fixture,
  movementId: string,
  direction: 'purchase' | 'sale' = 'purchase',
  override: Partial<AdvancePaymentInput> = {},
): AdvancePaymentInput {
  return {
    financialYearId: f.financialYear.id,
    movementId,
    direction,
    counterparty: { name: 'Partner SRL', taxId: '87654321', country: 'RO' },
    account: direction === 'purchase' ? '628' : '704',
    net: '100.00',
    vatCategory: f.vat === 'normal_vat' ? 'S' : 'O',
    counterpartyVatCollection: 'no',
    evidenceId: f.proof.id,
    evidenceDate: '2026-01-01',
    reference: key(),
    serviceExpectedOn: '2026-03-31',
    reason: 'Contract documents a payment before provision of the services',
    ...override,
  };
}
async function bankAdvance(
  f: Fixture,
  direction: 'purchase' | 'sale' = 'purchase',
  category: 'S' | 'O' = f.vat === 'normal_vat' ? 'S' : 'O',
  override: Partial<AdvancePaymentInput> = {},
) {
  const gross = category === 'S' ? '121.00' : '100.00',
    closing =
      direction === 'purchase'
        ? category === 'S'
          ? '879.00'
          : '900.00'
        : category === 'S'
          ? '1121.00'
          : '1100.00';
  await statement(
    f,
    '2026-01-01',
    '2026-01-31',
    '1000.00',
    closing,
    `ADV,2026-01-10,${direction === 'purchase' ? '-' : ''}${gross},RON,Contractual advance\n`,
  );
  const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
    request = paymentInput(f, movement.id, direction, { vatCategory: category, ...override }),
    proposal = await service.advances.proposePayment(f.actor, key(), request),
    posted = await post(f.actor, proposal);
  return { movement, request, proposal, ...posted, gross, closing };
}
async function imported(f: Fixture, xml: XmlInput = {}, contents?: string) {
  const proof = await source(
    f.actor,
    `${key()}.xml`,
    contents ?? invoiceXml({ date: '2026-02-01', number: key(), ...xml }),
  );
  return service.invoices.import(f.actor, key(), { evidenceId: proof.id });
}
function advanceInput(
  f: Fixture,
  invoiceId: string,
  override: Partial<AdvanceInvoiceInput> = {},
): AdvanceInvoiceInput {
  return {
    financialYearId: f.financialYear.id,
    invoiceId,
    recognitionDate: '2026-02-01',
    taxPointDate: '2026-02-01',
    account: '628',
    deduction: f.vat === 'normal_vat' ? 'full' : 'none',
    counterpartyVatCollection: 'no',
    paymentIds: [],
    evidenceId: f.proof.id,
    evidenceDate: '2026-01-01',
    reference: key(),
    serviceExpectedOn: '2026-03-31',
    reason: 'Contract and advance invoice document future service consideration',
    ...override,
  };
}
async function invoiced(
  f: Fixture,
  xml: XmlInput = {},
  override: Partial<AdvanceInvoiceInput> = {},
  contents?: string,
) {
  const invoice = await imported(f, xml, contents),
    request = advanceInput(f, invoice.id, override),
    proposal = await service.advances.proposeInvoice(f.actor, key(), request),
    posted = await post(f.actor, proposal);
  return { invoice, request, proposal, ...posted };
}
async function final(
  f: Fixture,
  advance: Awaited<ReturnType<typeof invoiced>>,
  xml: Partial<Parameters<typeof finalInvoiceXml>[0]> = {},
  override: Partial<AdvanceFinalInput> = {},
) {
  const direction = advance.invoice.direction,
    category = advance.invoice.body.taxes[0].category,
    net = category === 'S' ? '400.00' : '400.00',
    tax = category === 'S' ? '84.00' : '0.00',
    gross = category === 'S' ? '484.00' : '400.00';
  const invoice = await imported(
      f,
      {},
      finalInvoiceXml({
        number: key(),
        date: '2026-03-10',
        direction,
        category,
        net,
        tax,
        gross,
        serviceNet: '500.00',
        advances: [{ number: advance.invoice.body.number, lineId: 'A1', net: '100.00' }],
        ...xml,
      }),
    ),
    request: AdvanceFinalInput = {
      financialYearId: f.financialYear.id,
      invoiceId: invoice.id,
      recognitionDate: '2026-03-10',
      serviceDate: '2026-03-10',
      taxPointDate: '2026-03-10',
      treatmentEvidenceId: f.proof.id,
      account: direction === 'purchase' ? '628' : '704',
      deduction: advance.request.deduction,
      counterpartyVatCollection: 'no',
      allocations: [
        {
          advanceInvoiceId: advance.invoice.id,
          lineId: 'A1',
          net: '100.00',
          tax: category === 'S' ? '21.00' : '0.00',
        },
      ],
      ...override,
    };
  return {
    invoice,
    request,
    proposal: await service.advances.proposeFinalInvoice(f.actor, key(), request),
  };
}
async function balances(f: Fixture, financialYearId = f.financialYear.id, to?: string) {
  return Object.fromEntries(
    (await service.ledger.balance(f.actor, { financialYearId, to })).balances.map((row) => [
      row.account,
      row.closing,
    ]),
  );
}

describe('native service advances', () => {
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: a 2025 19-percent advance settles and regularizes at its original rate; a 21-percent transition needs separate treatment',
    async ({ direction }) => {
      const f = await fixture('normal_vat', 2025),
        advance = await invoiced(
          f,
          { date: '2025-04-01', direction, rate: '19', tax: '19.00', gross: '119.00' },
          {
            recognitionDate: '2025-04-01',
            taxPointDate: '2025-04-01',
            evidenceDate: '2025-03-01',
            serviceExpectedOn: '2025-06-30',
            account: direction === 'purchase' ? '628' : '704',
            deduction: direction === 'purchase' ? 'full' : 'none',
          },
        );
      await statement(
        f,
        '2025-04-01',
        '2025-04-30',
        '1000.00',
        direction === 'purchase' ? '881.00' : '1119.00',
        `PAY,2025-04-10,${direction === 'purchase' ? '-' : ''}119.00,RON,April advance\n`,
      );
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
          allocations: [{ invoiceId: advance.invoice.id, amount: '119.00' }],
        }),
      );
      await expect(
        final(
          f,
          advance,
          { date: '2025-08-10' },
          { recognitionDate: '2025-08-10', serviceDate: '2025-08-10', taxPointDate: '2025-08-10' },
        ),
      ).rejects.toMatchObject({ code: 'ADVANCE_FINAL_ORIGIN' });
      const completed = await final(
        f,
        advance,
        { date: '2025-06-10', rate: '19', tax: '76.00', gross: '476.00' },
        {
          recognitionDate: '2025-06-10',
          serviceDate: '2025-06-10',
          taxPointDate: '2025-06-10',
          allocations: [
            { advanceInvoiceId: advance.invoice.id, lineId: 'A1', net: '100.00', tax: '19.00' },
          ],
        },
      );
      await post(f.actor, completed.proposal);
      expect(
        await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          to: '2025-06-30',
        }),
      ).toMatchObject({
        status: 'reconciled',
        totals: {
          base: '500.00',
          inputTax: direction === 'purchase' ? '95.00' : '0.00',
          outputTax: direction === 'sale' ? '95.00' : '0.00',
        },
      });
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2025-06-30',
        }),
      ).toMatchObject({ status: 'reconciled' });
    },
  );
  test('dated bounded pages retain historical availability and company isolation', async () => {
    const f = await fixture(),
      other = await fixture(),
      payment = await bankAdvance(f),
      advance = await invoiced(
        f,
        { taxPointDate: '2026-01-10' },
        { taxPointDate: '2026-01-10', paymentIds: [payment.proposal.id] },
      );
    expect(await service.advances.payments(f.actor, { date: '2026-01-09' })).toMatchObject({
      items: [],
      nextCursor: null,
    });
    expect(
      (await service.advances.payments(f.actor, { date: '2026-01-31', limit: 1 })).items.map(
        (row) => row.id,
      ),
    ).toEqual([payment.proposal.id]);
    expect((await service.advances.payments(f.actor, { date: '2026-02-01' })).items).toHaveLength(
      0,
    );
    expect(
      (await service.advances.payments(f.actor, { date: '2026-02-01', onlyOpen: false })).items[0],
    ).toMatchObject({ status: 'invoiced' });
    expect(
      (
        await service.advances.list(f.actor, {
          date: '2026-02-01',
          direction: 'purchase',
          limit: 1,
        })
      ).items[0],
    ).toMatchObject({ invoiceId: advance.invoice.id, remainingNet: '100.00' });
    await expect(
      service.advances.get(other.actor, { invoiceId: advance.invoice.id, date: '2026-02-01' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.advances.getPayment(other.actor, { id: payment.proposal.id, date: '2026-02-01' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await service.advances.payments(other.actor, { date: '2026-02-01', onlyOpen: false })).items,
    ).toHaveLength(0);
    await post(f.actor, (await final(f, advance)).proposal);
    expect((await service.advances.list(f.actor, { date: '2026-02-28' })).items).toHaveLength(1);
    expect((await service.advances.list(f.actor, { date: '2026-03-31' })).items).toHaveLength(0);
  });
  test('reference mismatches, inconsistent negative lines, changed deduction and closed periods fail before posting', async () => {
    const f = await fixture(),
      payment = await bankAdvance(f),
      advance = await invoiced(
        f,
        { taxPointDate: '2026-01-10' },
        { taxPointDate: '2026-01-10', paymentIds: [payment.proposal.id] },
      );
    await expect(
      final(f, advance, { advances: [{ number: 'NOT-THE-ADVANCE', lineId: 'A1', net: '100.00' }] }),
    ).rejects.toMatchObject({ code: 'ADVANCE_REFERENCE' });
    await expect(
      final(
        f,
        advance,
        {},
        {
          allocations: [
            { advanceInvoiceId: advance.invoice.id, lineId: 'A1', net: '99.00', tax: '20.79' },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'ADVANCE_FINAL_LINES' });
    await expect(final(f, advance, {}, { deduction: 'none' })).rejects.toMatchObject({
      code: 'ADVANCE_FINAL_ORIGIN',
    });
    const another = await imported(f, { taxPointDate: '2026-01-10' });
    await expect(
      service.advances.proposeInvoice(
        f.actor,
        key(),
        advanceInput(f, another.id, {
          taxPointDate: '2026-01-10',
          paymentIds: [payment.proposal.id],
        }),
      ),
    ).rejects.toMatchObject({ code: 'ADVANCE_PAYMENT_RESOLVED' });
    await service.periods.close(f.actor, key(), '2026-01-01');
    await expect(
      service.advances.proposePayment(f.actor, key(), payment.request),
    ).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
  });
  test('a general 4092 balance without itemized advance provenance blocks close', async () => {
    const f = await fixture();
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        evidenceId: f.proof.id,
        date: '2026-01-15',
        purpose: 'general',
        description: 'Unitemized manual advance must not count as native coverage',
        sourceReference: key(),
        lines: [
          { account: '4092', debit: '100.00', credit: '0.00' },
          { account: '401', debit: '0.00', credit: '100.00' },
        ],
      }),
    );
    await statement(f, '2026-01-01', '2026-01-31', '1000.00', '1000.00');
    expect(
      await service.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-01-31',
      }),
    ).toMatchObject({
      status: 'needs_review',
      supplier: { ledger: '100.00', remaining: '0.00', difference: '100.00' },
    });
    await expect(service.periods.close(f.actor, key(), '2026-01-01')).rejects.toMatchObject({
      code: 'ADVANCE_CONTROL_DIFFERENCE',
    });
  });
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: December bank advance carries into a separately opened year with independent VAT periods',
    async ({ direction }) => {
      const f = await fixture('normal_vat', 2025),
        closing = direction === 'purchase' ? '879.00' : '1121.00';
      await statement(
        f,
        '2025-12-01',
        '2025-12-31',
        '1000.00',
        closing,
        `DEC,2025-12-10,${direction === 'purchase' ? '-' : ''}121.00,RON,December advance\n`,
      );
      const payment = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(
          f,
          (await service.queries.movements(f.actor, { matched: false })).items[0].id,
          direction,
          { evidenceDate: '2025-12-01' },
        ),
      );
      await post(f.actor, payment);
      await service.periods.close(f.actor, key(), '2025-12-01');
      const year = await service.foundation.createYear(f.actor, key(), {
          kind: 'financial',
          label: '2026',
          from: '2026-01-01',
          to: '2026-12-31',
        }),
        next = { ...f, financialYear: year };
      expect(
        await service.advances.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-31' }),
      ).toMatchObject({ status: 'needs_review' });
      await statement(next, '2026-01-01', '2026-01-31', closing, closing);
      await expect(service.periods.close(f.actor, key(), '2026-01-01')).rejects.toMatchObject({
        code: 'OPENING_REQUIRED',
      });
      await post(
        f.actor,
        await service.ledger.propose(f.actor, key(), {
          financialYearId: year.id,
          evidenceId: f.proof.id,
          date: year.from,
          purpose: 'opening',
          description: 'Explicit carried bank and advance balances',
          sourceReference: 'opening2026',
          lines:
            direction === 'purchase'
              ? [
                  { account: '5121', debit: closing, credit: '0.00' },
                  { account: '4092', debit: '121.00', credit: '0.00' },
                  { account: '1012', debit: '0.00', credit: '1000.00' },
                ]
              : [
                  { account: '5121', debit: closing, credit: '0.00' },
                  { account: '419', debit: '0.00', credit: '100.00' },
                  { account: '4427', debit: '0.00', credit: '21.00' },
                  { account: '1012', debit: '0.00', credit: '1000.00' },
                ],
        }),
      );
      const advance = await invoiced(
        next,
        { direction, date: '2026-01-10', taxPointDate: '2025-12-10' },
        {
          recognitionDate: '2026-01-10',
          taxPointDate: '2025-12-10',
          paymentIds: [payment.id],
          evidenceDate: '2025-12-01',
          account: direction === 'purchase' ? '628' : '704',
          deduction: direction === 'purchase' ? 'full' : 'none',
        },
      );
      await service.periods.close(f.actor, key(), '2026-01-01');
      await post(f.actor, (await final(next, advance)).proposal);
      expect(
        await service.advances.reconcile(f.actor, { financialYearId: year.id, date: '2026-03-31' }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: '0.00', outputTax: direction === 'sale' ? '21.00' : '0.00' },
      });
      expect(await service.vat.summary(f.actor, { financialYearId: year.id })).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: direction === 'purchase' ? '105.00' : '0.00',
          outputTax: direction === 'sale' ? '84.00' : '0.00',
        },
      });
    },
  );
  test('advance-only invoice types and negative final lines retain source identity and reject ordinary service interpretation', async () => {
    const f = await fixture(),
      ordinary = await imported(f),
      again = await service.invoices.import(f.actor, key(), { evidenceId: ordinary.evidenceId });
    expect(again).toEqual(ordinary);
    expect(ordinary.body.parserVersion).toBe('ubl-invoice-1');
    const contents = invoiceXml({ date: '2026-02-01', number: key() }).replace(
        '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>',
        '<cbc:InvoiceTypeCode>386</cbc:InvoiceTypeCode>',
      ),
      advance = await invoiced(f, {}, {}, contents);
    expect(advance.invoice.body.parserVersion).toBe('ubl-invoice-2');
    await expect(
      service.invoices.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        invoiceId: ordinary.id,
        recognitionDate: '2026-02-01',
        serviceDate: '2026-02-01',
        taxPointDate: '2026-02-01',
        treatmentEvidenceId: f.proof.id,
        account: '628',
        deduction: 'full',
        counterpartyVatCollection: 'no',
      }),
    ).resolves.toBeDefined();
    const request = {
      financialYearId: f.financialYear.id,
      invoiceId: advance.invoice.id,
      recognitionDate: '2026-02-01',
      serviceDate: '2026-02-01',
      taxPointDate: '2026-02-01',
      treatmentEvidenceId: f.proof.id,
      account: '628',
      deduction: 'full',
      counterpartyVatCollection: 'no',
    };
    await expect(service.invoices.propose(f.actor, key(), request)).rejects.toMatchObject({
      code: 'ADVANCE_INVOICE_REQUIRED',
    });
    const negative = await imported(
      f,
      {},
      finalInvoiceXml({
        number: key(),
        date: '2026-03-10',
        serviceNet: '500.00',
        net: '400.00',
        tax: '84.00',
        gross: '484.00',
        advances: [{ number: advance.invoice.body.number, lineId: 'A1', net: '100.00' }],
      }),
    );
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...request,
        invoiceId: negative.id,
        recognitionDate: '2026-03-10',
        serviceDate: '2026-03-10',
        taxPointDate: '2026-03-10',
      }),
    ).rejects.toMatchObject({ code: 'ADVANCE_FINAL_REQUIRED' });
  });
  test('balanced account mutations are rejected by both application and database advance guards', async () => {
    const f = await fixture(),
      payment = await bankAdvance(f),
      advance = await invoiced(
        f,
        { taxPointDate: '2026-01-10' },
        { taxPointDate: '2026-01-10', paymentIds: [payment.proposal.id] },
      ),
      completed = await final(f, advance),
      body = generalBodySchema.parse(completed.proposal.body);
    body.lines.find((row) => row.account === '4092')!.account = '471';
    const draft = await db.write(async (tx) => {
        const factId = key(),
          version = 1,
          hash = sha256(canonical({ kind: 'general', version, body, factId }));
        await tx.insert(facts).values({
          id: factId,
          companyId: f.company.id,
          kind: 'general',
          evidenceId: body.evidenceId,
          body,
          createdBy: f.actor.actorId,
        });
        return (
          await tx
            .insert(proposals)
            .values({
              id: key(),
              companyId: f.company.id,
              factId,
              kind: 'general',
              version,
              hash,
              body,
              sourceKey: key(),
              createdBy: f.actor.actorId,
            })
            .returning()
        )[0];
      }),
      approval = await service.books.approve(f.actor, key(), draft.id, review(draft));
    await expect(
      service.ledger.post(f.actor, key(), { id: draft.id, ...review(draft) }),
    ).rejects.toMatchObject({ code: 'STALE_ADVANCE_FINAL' });
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: draft.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
  });
  test('exact values above JS safe precision survive advance settlement, export and fresh restore with immutable projections', async () => {
    const f = await fixture('normal_vat', 2026, '1000000000000000.00'),
      netBani = 9007199254740993n,
      taxBani = (netBani * 21n + 50n) / 100n,
      decimal = (v: bigint) => `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`,
      net = decimal(netBani),
      tax = decimal(taxBani),
      gross = decimal(netBani + taxBani),
      closing = decimal(100000000000000000n - netBani - taxBani);
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000000000000000.00',
      closing,
      `BIG,2026-01-10,-${gross},RON,Exact large advance\n`,
    );
    const p = await service.advances.proposePayment(
      f.actor,
      key(),
      paymentInput(
        f,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        'purchase',
        { net },
      ),
    );
    await post(f.actor, p);
    const a = await invoiced(
      f,
      { net, tax, gross, taxPointDate: '2026-01-10' },
      { taxPointDate: '2026-01-10', paymentIds: [p.id] },
    );
    const completed = await final(
        f,
        a,
        {
          serviceNet: net,
          net: '0.00',
          tax: '0.00',
          gross: '0.00',
          advances: [{ number: a.invoice.body.number, lineId: 'A1', net }],
        },
        { allocations: [{ advanceInvoiceId: a.invoice.id, lineId: 'A1', net, tax }] },
      ),
      commandKey = key(),
      posted = await post(f.actor, completed.proposal, commandKey);
    const refundOpening = decimal(100000000000000000n - netBani - taxBani - 2420n);
    await statement(
      f,
      '2026-04-01',
      '2026-04-30',
      closing,
      refundOpening,
      'RETURNABLE,2026-04-10,-24.20,RON,Returnable service advance\n',
    );
    const returnable = await service.advances.proposePayment(
      f.actor,
      key(),
      paymentInput(
        f,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        'purchase',
        { net: '20.00', serviceExpectedOn: '2026-06-30' },
      ),
    );
    await post(f.actor, returnable);
    const agreement = await source(
      f.actor,
      'recovery-refund-agreement.txt',
      'Current written agreement returns the entire unbilled twenty lei service advance',
    );
    await statement(
      f,
      '2026-05-01',
      '2026-05-31',
      refundOpening,
      closing,
      'RESTORED-REFUND,2026-05-10,24.20,RON,Full return before invoice\n',
    );
    const refund = await service.advances.proposeRefund(f.actor, key(), {
      financialYearId: f.financialYear.id,
      paymentId: returnable.id,
      movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
      evidenceId: agreement.id,
      decisionDate: '2026-05-10',
      periodBasis: 'current_period_event',
      reason: 'Written current cancellation returns the entire unbilled advance',
    });
    await post(f.actor, refund);
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const data = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(data.advancePayments).toHaveLength(2);
    expect(data.advanceInvoices).toHaveLength(1);
    expect(data.advanceInvoiceMatches).toHaveLength(1);
    expect(data.advanceUses).toHaveLength(1);
    expect(data.advanceRefunds).toHaveLength(1);
    await backup(db, objects, join(directory, 'advance-backup'));
    const restored = await restore(
        join(directory, 'advance-backup'),
        join(directory, 'advance-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.advances.get(f.actor, { invoiceId: a.invoice.id, date: '2026-03-31' }),
      ).toMatchObject({ usedNet: net, remainingGross: '0.00' });
      expect(
        await copy.ledger.post(f.actor, commandKey, {
          id: completed.proposal.id,
          ...review(completed.proposal),
        }),
      ).toEqual(posted.entry);
      expect(
        await copy.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-03-31',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await copy.advances.getPayment(f.actor, { id: returnable.id, date: '2026-05-31' }),
      ).toMatchObject({ status: 'refunded', remainingGross: '0.00' });
      for (const table of [
        advancePayments,
        advanceInvoices,
        advanceInvoiceMatches,
        advanceUses,
        advanceRefunds,
      ]) {
        expect(
          await copyDb.orm.select().from(table).where(eq(table.companyId, f.company.id)),
        ).toEqual(await db.orm.select().from(table).where(eq(table.companyId, f.company.id)));
      }
      for (const table of [
        advancePayments,
        advanceInvoices,
        advanceInvoiceMatches,
        advanceUses,
        advanceRefunds,
      ])
        await expect(
          copyDb.orm.delete(table).where(eq(table.companyId, f.company.id)).execute(),
        ).rejects.toThrow();
      expect(await copy.documents.read(f.actor, a.invoice.evidenceId)).toMatchObject({
        bytes: (await service.documents.read(f.actor, a.invoice.evidenceId)).bytes,
      });
      expect(await copy.documents.read(f.actor, f.proof.id)).toMatchObject({
        bytes: (await service.documents.read(f.actor, f.proof.id)).bytes,
      });
    } finally {
      await copyDb.close();
    }
  });
  test('scoped MCP prepares and revises advances, waits for exact human approval and rejects revoked cached retries', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '879.00',
      'MCP,2026-01-10,-121.00,RON,Contract advance\n',
    );
    const input = paymentInput(
        f,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
      ),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Advance preparation',
        scopes: [
          'advances.proposePayment',
          'advances.revisePayment',
          'advances.getPayment',
          'vat.advancePayments',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'advance-contract', version: '1' },
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
      expect(names).toContain('advances.proposePayment');
      expect(names).not.toContain('books.approve');
      const draft = proposalOutput.parse(
        (
          await client.callTool({
            name: 'advances.proposePayment',
            arguments: { input, idempotencyKey: key() },
          })
        ).structuredContent,
      );
      await service.books.approve(f.actor, key(), draft.id, review(draft));
      const revised = proposalOutput.parse(
          (
            await client.callTool({
              name: 'advances.revisePayment',
              arguments: {
                input: {
                  ...input,
                  id: draft.id,
                  version: draft.version,
                  reason:
                    'Advance contract reviewed again against the separately retained evidence',
                },
                idempotencyKey: key(),
              },
            })
          ).structuredContent,
        ),
        exact = { input: { id: revised.id, ...review(revised) }, idempotencyKey: key() };
      expect(
        JSON.stringify(await client.callTool({ name: 'ledger.post', arguments: exact })),
      ).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), revised.id, review(revised));
      const posted = await client.callTool({ name: 'ledger.post', arguments: exact });
      expect(posted.isError).not.toBe(true);
      expect(
        (await client.callTool({ name: 'ledger.post', arguments: exact })).structuredContent,
      ).toEqual(posted.structuredContent);
      expect(
        advancePaymentOutput.parse(
          (
            await client.callTool({
              name: 'advances.getPayment',
              arguments: { input: { id: revised.id, date: '2026-01-31' } },
            })
          ).structuredContent,
        ),
      ).toMatchObject({ status: 'open', gross: '121.00' });
      expect(
        (
          await client.callTool({
            name: 'vat.advancePayments',
            arguments: { input: { financialYearId: f.financialYear.id } },
          })
        ).isError,
      ).not.toBe(true);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(client.callTool({ name: 'ledger.post', arguments: exact })).rejects.toThrow(
        'Unauthorized',
      );
    } finally {
      await client.close();
    }
  });
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: partial use and cancellation of the unused balance retain full service value and exact refund VAT',
    async ({ direction }) => {
      const f = await fixture(),
        payment = await bankAdvance(f, direction),
        advance = await invoiced(
          f,
          { direction, taxPointDate: '2026-01-10' },
          {
            taxPointDate: '2026-01-10',
            paymentIds: [payment.proposal.id],
            account: direction === 'purchase' ? '628' : '704',
            deduction: direction === 'purchase' ? 'full' : 'none',
          },
        );
      const completed = await final(
        f,
        advance,
        {
          serviceNet: '40.00',
          net: '0.00',
          tax: '0.00',
          gross: '0.00',
          advances: [{ number: advance.invoice.body.number, lineId: 'A1', net: '40.00' }],
        },
        {
          allocations: [
            { advanceInvoiceId: advance.invoice.id, lineId: 'A1', net: '40.00', tax: '8.40' },
          ],
        },
      );
      await post(f.actor, completed.proposal);
      expect(
        await service.positions.read(f.actor, {
          invoiceId: completed.invoice.id,
          date: '2026-03-10',
        }),
      ).toMatchObject({ gross: '0.00', balance: '0.00' });
      const agreement = await source(
          f.actor,
          'unused-cancellation.txt',
          'Written cancellation of the unused sixty lei service advance',
        ),
        credit = await imported(f, {
          credit: true,
          direction,
          number: key(),
          originalNumber: advance.invoice.body.number,
          date: '2026-04-01',
          net: '60.00',
          tax: '12.60',
          gross: '72.60',
        }),
        creditInput = {
          financialYearId: f.financialYear.id,
          invoiceId: credit.id,
          originalInvoiceId: advance.invoice.id,
          recognitionDate: '2026-04-01',
          decisionDate: '2026-04-01',
          treatmentEvidenceId: agreement.id,
          kind: 'cancellation',
          periodBasis: 'current_period_event',
          reason: 'Unused services are cancelled under the separately retained agreement',
        };
      await expect(
        service.invoices.proposeCreditNote(f.actor, key(), creditInput),
      ).rejects.toMatchObject({ code: 'ADVANCE_CREDIT_TREATMENT' });
      await post(f.actor, await service.advances.proposeCreditNote(f.actor, key(), creditInput));
      expect(
        await service.positions.read(f.actor, {
          invoiceId: advance.invoice.id,
          date: '2026-04-01',
        }),
      ).toMatchObject({ balance: '-72.60', status: 'refund_due' });
      await statement(
        f,
        '2026-04-01',
        '2026-04-30',
        payment.closing,
        direction === 'purchase' ? '951.60' : '1048.40',
        `REFUND,2026-04-10,${direction === 'purchase' ? '' : '-'}72.60,RON,Unused advance refund\n`,
      );
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
          allocations: [{ invoiceId: advance.invoice.id, amount: '-72.60' }],
        }),
      );
      expect((await balances(f))[direction === 'purchase' ? '628' : '704']).toBe(
        direction === 'purchase' ? '40.00' : '-40.00',
      );
      expect(
        await service.advances.get(f.actor, { invoiceId: advance.invoice.id, date: '2026-04-30' }),
      ).toMatchObject({ usedNet: '40.00', creditedNet: '60.00', remainingControl: '0.00' });
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-04-30',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: direction === 'purchase' ? '8.40' : '0.00',
          outputTax: direction === 'sale' ? '8.40' : '0.00',
        },
      });
    },
  );
  test('grouped payments and multiple referenced advance invoices reconcile without repeating the original VAT', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '879.00',
      'ONE,2026-01-10,-60.50,RON,First advance\nTWO,2026-01-11,-60.50,RON,Second advance\n',
    );
    const movements = (await service.queries.movements(f.actor, { matched: false })).items,
      advances = [];
    for (const movement of movements) {
      const p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, movement.id, 'purchase', { net: '50.00' }),
      );
      await post(f.actor, p);
      advances.push(
        await invoiced(
          f,
          { net: '50.00', tax: '10.50', gross: '60.50', taxPointDate: movement.date },
          { taxPointDate: movement.date, paymentIds: [p.id] },
        ),
      );
    }
    const doc = await imported(
      f,
      {},
      finalInvoiceXml({
        number: key(),
        date: '2026-03-10',
        serviceNet: '500.00',
        net: '400.00',
        tax: '84.00',
        gross: '484.00',
        advances: advances.map((row, i) => ({
          number: row.invoice.body.number,
          lineId: `A${i}`,
          net: '50.00',
        })),
      }),
    );
    await post(
      f.actor,
      await service.advances.proposeFinalInvoice(f.actor, key(), {
        financialYearId: f.financialYear.id,
        invoiceId: doc.id,
        recognitionDate: '2026-03-10',
        serviceDate: '2026-03-10',
        taxPointDate: '2026-03-10',
        treatmentEvidenceId: f.proof.id,
        account: '628',
        deduction: 'full',
        counterpartyVatCollection: 'no',
        allocations: advances.map((row, i) => ({
          advanceInvoiceId: row.invoice.id,
          lineId: `A${i}`,
          net: '50.00',
          tax: '10.50',
        })),
      }),
    );
    expect((await balances(f))['628']).toBe('500.00');
    expect((await balances(f))['4092']).toBe('0.00');
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { base: '500.00', inputTax: '105.00' } });
    expect(await service.invoices.import(f.actor, key(), { evidenceId: doc.evidenceId })).toEqual(
      doc,
    );
  });
  test('one advance invoice can fully match several earlier bank payments', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '879.00',
      'ONE,2026-01-10,-72.60,RON,First payment\nTWO,2026-01-11,-48.40,RON,Second payment\n',
    );
    const paymentIds = [];
    for (const movement of (await service.queries.movements(f.actor, { matched: false })).items) {
      const p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, movement.id, 'purchase', {
          net: movement.amount === '-72.60' ? '60.00' : '40.00',
        }),
      );
      await post(f.actor, p);
      paymentIds.push(p.id);
    }
    const advance = await invoiced(
      f,
      { taxPointDate: '2026-01-10' },
      { taxPointDate: '2026-01-10', paymentIds },
    );
    expect(
      await service.positions.read(f.actor, { invoiceId: advance.invoice.id, date: '2026-02-01' }),
    ).toMatchObject({ balance: '0.00', settled: '121.00' });
    expect(
      await service.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-01',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });
  test('competing final allocations invalidate approval even when both amounts still fit, and database guards reject bypassed stale posting', async () => {
    const f = await fixture(),
      payment = await bankAdvance(f),
      advance = await invoiced(
        f,
        { taxPointDate: '2026-01-10' },
        { taxPointDate: '2026-01-10', paymentIds: [payment.proposal.id] },
      );
    const options = {
        serviceNet: '40.00',
        net: '0.00',
        tax: '0.00',
        gross: '0.00',
        advances: [{ number: advance.invoice.body.number, lineId: 'A1', net: '40.00' }],
      },
      allocations = [
        { advanceInvoiceId: advance.invoice.id, lineId: 'A1', net: '40.00', tax: '8.40' },
      ];
    const a = await final(f, advance, options, { allocations }),
      b = await final(f, advance, options, { allocations }),
      approval = await service.books.approve(f.actor, key(), b.proposal.id, review(b.proposal));
    await post(f.actor, a.proposal);
    await expect(
      service.ledger.post(f.actor, key(), { id: b.proposal.id, ...review(b.proposal) }),
    ).rejects.toMatchObject({ code: 'STALE_ADVANCE_FINAL' });
    const body = generalBodySchema.parse(b.proposal.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: b.proposal.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const revised = await service.advances.proposeFinalInvoice(f.actor, key(), b.request, {
      id: b.proposal.id,
      version: b.proposal.version,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: revised.id, ...review(revised) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, revised);
    expect(
      await service.advances.get(f.actor, { invoiceId: advance.invoice.id, date: '2026-03-31' }),
    ).toMatchObject({ usedNet: '80.00', remainingNet: '20.00' });
  });
  test('cash refund and invoice matching cannot both consume the same payment', async () => {
    const f = await fixture(),
      payment = await bankAdvance(f),
      agreement = await source(
        f.actor,
        'refund-agreement.txt',
        'Current agreement to refund the whole bank advance',
      );
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      payment.closing,
      '1000.00',
      'REFUND,2026-02-10,121.00,RON,Returned advance\n',
    );
    const pending = await service.advances.proposeRefund(f.actor, key(), {
        financialYearId: f.financialYear.id,
        paymentId: payment.proposal.id,
        movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        evidenceId: agreement.id,
        decisionDate: '2026-02-10',
        periodBasis: 'current_period_event',
        reason: 'Agreement cancels services and returns the complete advance',
      }),
      approval = await service.books.approve(f.actor, key(), pending.id, review(pending));
    await invoiced(
      f,
      { taxPointDate: '2026-01-10' },
      { taxPointDate: '2026-01-10', paymentIds: [payment.proposal.id] },
    );
    await expect(
      service.ledger.post(f.actor, key(), { id: pending.id, ...review(pending) }),
    ).rejects.toMatchObject({ code: 'ADVANCE_PAYMENT_RESOLVED' });
    const body = generalBodySchema.parse(pending.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: pending.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
  });
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: bank advance before invoice closes, later invoice preserves VAT timing, final invoice and residual payment clear the controls',
    async ({ direction }) => {
      const f = await fixture(),
        payment = await bankAdvance(f, direction);
      expect(
        await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          to: '2026-01-31',
        }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: '0.00', outputTax: direction === 'sale' ? '21.00' : '0.00' },
      });
      await service.periods.close(f.actor, key(), '2026-01-01');
      const advance = await invoiced(
        f,
        { direction, taxPointDate: '2026-01-10' },
        {
          account: direction === 'purchase' ? '628' : '704',
          deduction: direction === 'purchase' ? 'full' : 'none',
          taxPointDate: '2026-01-10',
          paymentIds: [payment.proposal.id],
        },
      );
      expect(
        await service.positions.read(f.actor, {
          invoiceId: advance.invoice.id,
          date: '2026-02-01',
        }),
      ).toMatchObject({ balance: '0.00', settled: '121.00' });
      expect(
        await service.advances.getPayment(f.actor, { id: payment.proposal.id, date: '2026-01-31' }),
      ).toMatchObject({ status: 'open', remainingGross: '121.00' });
      expect(
        await service.advances.getPayment(f.actor, { id: payment.proposal.id, date: '2026-02-01' }),
      ).toMatchObject({
        status: 'invoiced',
        remainingGross: '0.00',
        invoiceId: advance.invoice.id,
      });
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-02-28',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          from: '2026-02-01',
          to: '2026-02-28',
        }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: direction === 'purchase' ? '21.00' : '0.00', outputTax: '0.00' },
      });
      await statement(f, '2026-02-01', '2026-02-28', payment.closing, payment.closing);
      await service.periods.close(f.actor, key(), '2026-02-01');
      const completed = await final(f, advance);
      await post(f.actor, completed.proposal);
      const closing = direction === 'purchase' ? '395.00' : '1605.00';
      await statement(
        f,
        '2026-03-01',
        '2026-03-31',
        payment.closing,
        closing,
        `REST,2026-03-20,${direction === 'purchase' ? '-' : ''}484.00,RON,Final invoice\n`,
      );
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
          allocations: [{ invoiceId: completed.invoice.id, amount: '484.00' }],
        }),
      );
      await service.periods.close(f.actor, key(), '2026-03-01');
      expect(await balances(f)).toMatchObject(
        direction === 'purchase'
          ? { '4092': '0.00', '401': '0.00', '628': '500.00', '4426': '105.00', '5121': closing }
          : { '419': '0.00', '4111': '0.00', '704': '-500.00', '4427': '-105.00', '5121': closing },
      );
      expect(
        await service.advances.get(f.actor, { invoiceId: advance.invoice.id, date: '2026-03-31' }),
      ).toMatchObject({ usedNet: '100.00', remainingNet: '0.00', status: 'used' });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: {
          base: '500.00',
          inputTax: direction === 'purchase' ? '105.00' : '0.00',
          outputTax: direction === 'sale' ? '105.00' : '0.00',
        },
      });
    },
  );
  test.each([
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'O' as const,
      cost: '500.00',
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'S' as const,
      cost: '605.00',
      deduction: 'none' as const,
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      category: 'S' as const,
      cost: '605.00',
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      category: 'O' as const,
      cost: '-500.00',
      deduction: 'none' as const,
    },
  ])(
    '$vat $direction $category: irrecoverable VAT remains cost and non-VAT sales produce no output VAT',
    async ({ vat, direction, category, cost, deduction }) => {
      const f = await fixture(vat),
        payment = await bankAdvance(f, direction, category),
        advance = await invoiced(
          f,
          {
            direction,
            category,
            tax: category === 'S' ? '21.00' : '0.00',
            gross: category === 'S' ? '121.00' : '100.00',
          },
          {
            account: direction === 'purchase' ? '628' : '704',
            deduction,
            taxPointDate: '2026-01-10',
            paymentIds: [payment.proposal.id],
          },
        );
      const completed = await final(f, advance);
      await post(f.actor, completed.proposal);
      expect((await balances(f))[direction === 'purchase' ? '628' : '704']).toBe(cost);
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-03-31',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00', outputTax: '0.00' } });
    },
  );
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: an invoice-first advance requires full settlement before final regularization',
    async ({ direction }) => {
      const f = await fixture(),
        advance = await invoiced(
          f,
          { direction },
          {
            account: direction === 'purchase' ? '628' : '704',
            deduction: direction === 'purchase' ? 'full' : 'none',
          },
        );
      await expect(final(f, advance)).rejects.toMatchObject({ code: 'ADVANCE_UNSETTLED' });
      const closing = direction === 'purchase' ? '879.00' : '1121.00';
      await statement(
        f,
        '2026-02-01',
        '2026-02-28',
        '1000.00',
        closing,
        `PAY,2026-02-10,${direction === 'purchase' ? '-' : ''}121.00,RON,Advance invoice\n`,
      );
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
          allocations: [{ invoiceId: advance.invoice.id, amount: '121.00' }],
        }),
      );
      const completed = await final(f, advance);
      await post(f.actor, completed.proposal);
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-03-31',
        }),
      ).toMatchObject({ status: 'reconciled' });
    },
  );
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: full bank refund before invoice reverses only the unbilled advance and its original receipt VAT',
    async ({ direction }) => {
      const f = await fixture(),
        payment = await bankAdvance(f, direction),
        agreement = await source(
          f.actor,
          'refund.txt',
          'Written current cancellation and full return of unprovided services',
        );
      await statement(
        f,
        '2026-02-01',
        '2026-02-28',
        payment.closing,
        '1000.00',
        `REFUND,2026-02-10,${direction === 'purchase' ? '' : '-'}121.00,RON,Refund of advance\n`,
      );
      const proposal = await service.advances.proposeRefund(f.actor, key(), {
        financialYearId: f.financialYear.id,
        paymentId: payment.proposal.id,
        movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        evidenceId: agreement.id,
        decisionDate: '2026-02-10',
        periodBasis: 'current_period_event',
        reason: 'The written cancellation returns the whole uninvoiced advance',
      });
      await post(f.actor, proposal);
      expect(
        await service.advances.getPayment(f.actor, { id: payment.proposal.id, date: '2026-02-28' }),
      ).toMatchObject({ status: 'refunded', remainingGross: '0.00' });
      expect((await balances(f))[direction === 'purchase' ? '4092' : '419']).toBe('0.00');
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00', outputTax: '0.00' } });
      await service.periods.close(f.actor, key(), '2026-02-01');
    },
  );
});
