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
  type AdvanceRefundInput,
  type GeneralBody,
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
  journals,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { finalInvoiceXml } from './fixtures/advance';
const key = () => randomUUID(),
  review = (p: { version: number; hash: string }) => ({ version: p.version, hash: p.hash }),
  secret = 'synthetic-partial-refund-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-partial-refunds-'));
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
        email: 'partial-refunds@example.test',
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

async function refund(
  f: Fixture,
  paymentId: string,
  movementId: string,
  changes: Partial<AdvanceRefundInput> = {},
) {
  const agreement = await source(
      f.actor,
      `${key()}.txt`,
      `Separate current agreement for a partial advance refund ${key()}`,
    ),
    input: AdvanceRefundInput = {
      financialYearId: f.financialYear.id,
      paymentId,
      movementId,
      evidenceId: agreement.id,
      decisionDate: '2026-02-01',
      periodBasis: 'current_period_event',
      reason: 'Return only the documented unused part of the bank advance',
      ...changes,
    },
    proposal = await service.advances.proposeRefund(f.actor, key(), input);
  return { agreement, input, proposal };
}
const exact = (p: { id: string; version: number; hash: string }) => ({ id: p.id, ...review(p) });
async function rawRefund(f: Fixture, template: GeneralBody, mutate: (body: GeneralBody) => void) {
  const body = structuredClone(template);
  mutate(body);
  const p = await db.write(async (tx) => {
    const factId = key(),
      hash = sha256(canonical({ kind: 'general', version: 1, body, factId }));
    await tx.insert(facts).values({
      id: factId,
      companyId: f.company.id,
      kind: 'general',
      body,
      evidenceId: body.evidenceId,
      createdBy: ownerId,
    });
    const [row] = await tx
      .insert(proposals)
      .values({
        id: key(),
        companyId: f.company.id,
        factId,
        kind: 'general',
        version: 1,
        body,
        hash,
        sourceKey: key(),
        createdBy: ownerId,
      })
      .returning();
    return row;
  });
  const approval = await service.books.approve(f.actor, key(), p.id, review(p));
  return db.write((tx) =>
    postJournal(tx, f.actor, {
      date: body.date,
      kind: 'general',
      sourceId: p.id,
      approvalId: approval.id,
      evidenceId: body.evidenceId,
      description: body.description,
      lines: body.lines,
    }),
  );
}

describe('partial pre-invoice advance refunds', () => {
  test.each([
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      category: 'S' as const,
      deduction: 'full' as const,
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      category: 'S' as const,
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'S' as const,
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'O' as const,
      deduction: 'none' as const,
    },
    {
      vat: 'normal_vat' as const,
      direction: 'sale' as const,
      category: 'S' as const,
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      category: 'O' as const,
      deduction: 'none' as const,
    },
  ])(
    '$vat $direction $category $deduction: refund, remaining invoice and final service reconcile without duplicated VAT',
    async (c) => {
      const f = await fixture(c.vat),
        p = await bankAdvance(f, c.direction, c.category),
        tax = c.category === 'S',
        gross = tax ? '36.30' : '30.00',
        remainingGross = tax ? '84.70' : '70.00',
        closing =
          c.direction === 'purchase' ? (tax ? '915.30' : '930.00') : tax ? '1084.70' : '1070.00';
      await statement(
        f,
        '2026-02-01',
        '2026-02-28',
        p.closing,
        closing,
        `REFUND,2026-02-01,${c.direction === 'sale' ? '-' : ''}${gross},RON,Partial return\n`,
      );
      const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
        r = await refund(f, p.proposal.id, movement.id, { net: '30.00' }),
        body = generalBodySchema.parse(r.proposal.body);
      expect(body.advanceRefund).toMatchObject({
        net: '30.00',
        tax: tax ? '6.30' : '0.00',
        gross,
        controlAmount: c.direction === 'purchase' ? gross : '30.00',
        refundBasis: {
          requestedNet: '30.00',
          priorRefundCount: 0,
          priorRefundJournalId: null,
          before: { net: '100.00', tax: tax ? '21.00' : '0.00', gross: p.gross },
          after: { net: '70.00', tax: tax ? '14.70' : '0.00', gross: remainingGross },
        },
      });
      expect(body.lines.some((row) => row.account === '4426')).toBe(false);
      const executionKey = key(),
        posted = await post(f.actor, r.proposal, executionKey);
      expect(await service.ledger.post(f.actor, executionKey, exact(r.proposal))).toEqual(
        posted.entry,
      );
      expect(
        (await db.orm.select().from(proposals).where(eq(proposals.id, p.proposal.id)))[0].hash,
      ).toBe(p.proposal.hash);
      expect(
        advancePaymentOutput.parse(
          await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
        ),
      ).toMatchObject({
        status: 'open',
        refundedNet: '30.00',
        refundedTax: tax ? '6.30' : '0.00',
        refundedGross: gross,
        remainingNet: '70.00',
        remainingGross,
        refunds: [{ journalId: posted.entry.id, gross }],
      });
      expect(
        (
          await service.advances.payments(f.actor, { date: '2026-02-28', onlyOpen: true })
        ).items.map((row) => row.id),
      ).toContain(p.proposal.id);
      expect(
        await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-01-31' }),
      ).toMatchObject({ status: 'open', remainingGross: p.gross, refundJournalId: null });
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-02-28',
        }),
      ).toMatchObject({ status: 'reconciled' });
      await service.periods.close(f.actor, key(), '2026-02-01');
      const a = await invoiced(
        f,
        {
          direction: c.direction,
          category: c.category,
          date: '2026-03-01',
          net: '70.00',
          tax: tax ? '14.70' : '0.00',
          gross: remainingGross,
          taxPointDate: '2026-01-10',
        },
        {
          recognitionDate: '2026-03-01',
          taxPointDate: '2026-01-10',
          account: c.direction === 'purchase' ? '628' : '704',
          deduction: c.deduction,
          paymentIds: [p.proposal.id],
          serviceExpectedOn: '2026-04-30',
        },
      );
      expect(generalBodySchema.parse(a.proposal.body).invoice!.advance!.payments[0]).toMatchObject({
        net: '70.00',
        tax: tax ? '14.70' : '0.00',
        gross: remainingGross,
      });
      expect(
        await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2026-03-01' }),
      ).toMatchObject({ balance: '0.00' });
      const finalProof = await final(
        f,
        a,
        {
          net: '0.00',
          tax: '0.00',
          gross: '0.00',
          serviceNet: '70.00',
          advances: [{ number: a.invoice.body.number, lineId: 'A1', net: '70.00' }],
        },
        {
          allocations: [
            {
              advanceInvoiceId: a.invoice.id,
              lineId: 'A1',
              net: '70.00',
              tax: tax ? '14.70' : '0.00',
            },
          ],
        },
      );
      await post(f.actor, finalProof.proposal);
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-03-31',
        }),
      ).toMatchObject({
        status: 'reconciled',
        supplier: { remaining: '0.00' },
        customer: { remaining: '0.00' },
      });
      const totals = await service.vat.summary(f.actor, { financialYearId: f.financialYear.id });
      expect(totals).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: c.direction === 'purchase' && c.deduction === 'full' ? '14.70' : '0.00',
          outputTax: c.direction === 'sale' && tax ? '14.70' : '0.00',
        },
      });
      expect(await balances(f)).toMatchObject({
        '5121': closing,
        [c.direction === 'purchase' ? '628' : '704']:
          c.direction === 'sale' ? '-70.00' : tax && c.deduction === 'none' ? '84.70' : '70.00',
      });
    },
  );
  test.each(['purchase', 'sale'] as const)(
    '%s: successive refunds consume only the remaining advance and omission returns its exact final balance',
    async (direction) => {
      const f = await fixture(),
        p = await bankAdvance(f, direction);
      await statement(
        f,
        '2026-02-01',
        '2026-02-28',
        p.closing,
        '1000.00',
        `R1,2026-02-01,${direction === 'sale' ? '-' : ''}36.30,RON,refund-1\nR2,2026-02-02,${direction === 'sale' ? '-' : ''}24.20,RON,refund-2\nR3,2026-02-03,${direction === 'sale' ? '-' : ''}60.50,RON,refund-3\n`,
      );
      const movements = (await service.queries.movements(f.actor, { matched: false })).items;
      const r1 = await refund(
        f,
        p.proposal.id,
        movements.find((row) => row.reference === 'refund-1')!.id,
        { net: '30.00' },
      );
      await post(f.actor, r1.proposal);
      const r2 = await refund(
        f,
        p.proposal.id,
        movements.find((row) => row.reference === 'refund-2')!.id,
        { net: '20.00', decisionDate: '2026-02-02' },
      );
      await post(f.actor, r2.proposal);
      expect(
        (await service.advances.payments(f.actor, { date: '2026-02-02', onlyOpen: true })).items,
      ).toHaveLength(1);
      const r3 = await refund(
          f,
          p.proposal.id,
          movements.find((row) => row.reference === 'refund-3')!.id,
          { decisionDate: '2026-02-03' },
        ),
        effect = generalBodySchema.parse(r3.proposal.body).advanceRefund!;
      expect(effect).toMatchObject({
        net: '50.00',
        tax: '10.50',
        gross: '60.50',
        refundBasis: {
          requestedNet: null,
          priorRefundCount: 2,
          before: { gross: '60.50' },
          after: { gross: '0.00' },
        },
      });
      await post(f.actor, r3.proposal);
      expect(
        await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
      ).toMatchObject({ status: 'refunded', remainingGross: '0.00', refundedGross: '121.00' });
      expect(
        (await service.advances.payments(f.actor, { date: '2026-02-28', onlyOpen: true })).items,
      ).toHaveLength(0);
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-02-28',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00', outputTax: '0.00' } });
      expect((await balances(f))['5121']).toBe('1000.00');
    },
  );
});

describe('partial refund authority and exact history', () => {
  test('competing partial refunds require a fresh exact approval after another refund changes the balance', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale');
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '1048.40',
      'R1,2026-02-01,-36.30,RON,first\nR2,2026-02-01,-36.30,RON,second\n',
    );
    const movements = (await service.queries.movements(f.actor, { matched: false })).items,
      a = await refund(f, p.proposal.id, movements.find((row) => row.reference === 'first')!.id, {
        net: '30.00',
      }),
      b = await refund(f, p.proposal.id, movements.find((row) => row.reference === 'second')!.id, {
        net: '30.00',
      });
    for (const r of [a, b])
      await service.books.approve(f.actor, key(), r.proposal.id, review(r.proposal));
    await service.ledger.post(f.actor, key(), exact(a.proposal));
    await expect(service.ledger.post(f.actor, key(), exact(b.proposal))).rejects.toMatchObject({
      code: 'STALE_ADVANCE_REFUND',
    });
    const revised = await service.advances.proposeRefund(f.actor, key(), b.input, {
      id: b.proposal.id,
      version: b.proposal.version,
    });
    expect(generalBodySchema.parse(revised.body).advanceRefund!.refundBasis).toMatchObject({
      priorRefundCount: 1,
      before: { gross: '84.70' },
      after: { gross: '48.40' },
    });
    await expect(service.ledger.post(f.actor, key(), exact(revised))).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await post(f.actor, revised);
    expect(
      await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({ remainingGross: '48.40', refundedGross: '72.60', status: 'open' });
  });
  test('partial refund and invoicing cannot both consume a stale payment snapshot', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale');
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '1084.70',
      'R,2026-02-01,-36.30,RON,partial\n',
    );
    const document = await imported(f, { direction: 'sale', taxPointDate: '2026-01-10' }),
      invoiceInput = advanceInput(f, document.id, {
        taxPointDate: '2026-01-10',
        account: '704',
        deduction: 'none',
        paymentIds: [p.proposal.id],
      }),
      invoice = await service.advances.proposeInvoice(f.actor, key(), invoiceInput),
      r = await refund(
        f,
        p.proposal.id,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        { net: '30.00' },
      );
    await service.books.approve(f.actor, key(), invoice.id, review(invoice));
    await post(f.actor, r.proposal);
    await expect(service.ledger.post(f.actor, key(), exact(invoice))).rejects.toMatchObject({
      code: 'ADVANCE_INVOICE_TOTAL',
    });
    await expect(
      rawRefund(f, generalBodySchema.parse(invoice.body), () => {}).catch((error) => {
        throw error.cause ?? error;
      }),
    ).rejects.toThrow('invalid_or_stale_advance_invoice');
    expect(
      await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({ status: 'open', remainingGross: '84.70', invoiceId: null });
  });
  test('independent SQLite guards reject restored budgets, invented prior refunds, wrong VAT and changed balanced lines', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale');
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '1060.50',
      'R1,2026-02-01,-36.30,RON,first\nR2,2026-02-02,-24.20,RON,second\n',
    );
    const movements = (await service.queries.movements(f.actor, { matched: false })).items,
      first = await refund(
        f,
        p.proposal.id,
        movements.find((row) => row.reference === 'first')!.id,
        { net: '30.00' },
      );
    await post(f.actor, first.proposal);
    const second = await refund(
        f,
        p.proposal.id,
        movements.find((row) => row.reference === 'second')!.id,
        { net: '20.00', decisionDate: '2026-02-02' },
      ),
      base = generalBodySchema.parse(second.proposal.body);
    const mutations: Array<(b: GeneralBody) => void> = [
      (b) => {
        Reflect.deleteProperty(b.advanceRefund!, 'refundBasis');
      },
      (b) => {
        b.advanceRefund!.refundBasis!.before.gross = '121.00';
      },
      (b) => {
        b.advanceRefund!.refundBasis!.after.gross = '84.70';
      },
      (b) => {
        b.advanceRefund!.refundBasis!.priorRefundCount = 0;
      },
      (b) => {
        b.advanceRefund!.refundBasis!.priorRefundJournalId = key();
      },
      (b) => {
        b.advanceRefund!.refundBasis!.priorRefundFinancialYearId = key();
      },
      (b) => {
        b.advanceRefund!.refundBasis!.requestedNet = '30.00';
      },
      (b) => {
        b.advanceRefund!.tax = '0.00';
        b.advanceRefund!.net = '24.20';
        b.lines[0].debit = '24.20';
        b.lines = b.lines.filter((row) => row.account !== '4427');
      },
      (b) => {
        b.advanceRefund!.ruleId = 'ro-domestic-standard-2025-01';
      },
      (b) => {
        b.advanceRefund!.evidenceId = first.agreement.id;
        b.advanceRefund!.evidenceHash = first.agreement.hash;
      },
      (b) => {
        b.lines[0].account = '704';
      },
      (b) => {
        b.advanceRefund!.originalTaxPointDate = '2026-02-02';
      },
    ];
    for (const mutation of mutations)
      await expect(
        rawRefund(f, base, mutation).catch((error) => {
          throw error.cause ?? error;
        }),
      ).rejects.toThrow('invalid_or_resolved_advance_refund');
    await post(f.actor, second.proposal);
    expect(
      (await db.orm.select().from(advanceRefunds).where(eq(advanceRefunds.companyId, f.company.id)))
        .length,
    ).toBe(2);
    await expect(
      db.orm.delete(advanceRefunds).where(eq(advanceRefunds.companyId, f.company.id)).execute(),
    ).rejects.toThrow();
  });
  test('zero/excess bases, wrong whole movements, reused agreements and cross-company evidence fail closed', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'purchase');
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '939.50',
      'R1,2026-02-01,36.30,RON,first\nR2,2026-02-02,24.20,RON,second\n',
    );
    const rows = (await service.queries.movements(f.actor, { matched: false })).items,
      movement = rows.find((row) => row.reference === 'first')!.id;
    for (const net of ['0.00', '101.00', '29.99'])
      await expect(refund(f, p.proposal.id, movement, { net })).rejects.toMatchObject({
        code: 'ADVANCE_REFUND_AMOUNT',
      });
    await expect(refund(f, p.proposal.id, movement)).rejects.toMatchObject({
      code: 'ADVANCE_REFUND_AMOUNT',
    });
    await expect(
      refund(f, p.proposal.id, movement, { net: '30.00', evidenceId: f.proof.id }),
    ).rejects.toMatchObject({ code: 'ADVANCE_REFUND_EVIDENCE' });
    const first = await refund(f, p.proposal.id, movement, { net: '30.00' });
    await post(f.actor, first.proposal);
    await expect(
      refund(f, p.proposal.id, rows.find((row) => row.reference === 'second')!.id, {
        net: '20.00',
        decisionDate: '2026-02-02',
        evidenceId: first.agreement.id,
      }),
    ).rejects.toMatchObject({ code: 'ADVANCE_REFUND_EVIDENCE' });
    const other = await fixture();
    await expect(
      refund(f, p.proposal.id, rows.find((row) => row.reference === 'second')!.id, {
        net: '20.00',
        decisionDate: '2026-02-02',
        evidenceId: other.proof.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  test('cent rounding is retained on the final residual refund instead of losing original VAT', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '1000.04',
      'P,2026-01-10,0.04,RON,Tiny advance\n',
    );
    const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
      p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, movement.id, 'sale', { net: '0.03' }),
      );
    await post(f.actor, p);
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      '1000.04',
      '1000.00',
      'R1,2026-02-01,-0.01,RON,tiny-1\nR2,2026-02-02,-0.01,RON,tiny-2\nR3,2026-02-03,-0.02,RON,tiny-3\n',
    );
    const rows = (await service.queries.movements(f.actor, { matched: false })).items;
    for (const [reference, net, date, tax] of [
      ['tiny-1', '0.01', '2026-02-01', '0.00'],
      ['tiny-2', '0.01', '2026-02-02', '0.00'],
      ['tiny-3', undefined, '2026-02-03', '0.01'],
    ] as const) {
      const r = await refund(f, p.id, rows.find((row) => row.reference === reference)!.id, {
        net,
        decisionDate: date,
      });
      expect(generalBodySchema.parse(r.proposal.body).advanceRefund!.tax).toBe(tax);
      await post(f.actor, r.proposal);
    }
    expect(
      await service.advances.getPayment(f.actor, { id: p.id, date: '2026-02-28' }),
    ).toMatchObject({ status: 'refunded', refundedTax: '0.01', refundedGross: '0.04' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { outputTax: '0.00' } });
  });
  test('large exact partial refunds and final residuals retain every ban beyond Number precision', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '8478711098237609.94',
      'P,2026-01-10,8478711098236609.94,RON,Large advance\n',
    );
    const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
      p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, movement.id, 'sale', { net: '7007199254740999.95' }),
      );
    await post(f.actor, p);
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      '8478711098237609.94',
      '1000.00',
      'R1,2026-02-01,-8478711098236489.01,RON,large-1\nR2,2026-02-02,-120.93,RON,large-2\n',
    );
    const rows = (await service.queries.movements(f.actor, { matched: false })).items,
      r = await refund(f, p.id, rows.find((row) => row.reference === 'large-1')!.id, {
        net: '7007199254740900.01',
      });
    await post(f.actor, r.proposal);
    expect(
      await service.advances.getPayment(f.actor, { id: p.id, date: '2026-02-01' }),
    ).toMatchObject({ remainingNet: '99.94', remainingTax: '20.99', remainingGross: '120.93' });
    const last = await refund(f, p.id, rows.find((row) => row.reference === 'large-2')!.id, {
      decisionDate: '2026-02-02',
    });
    await post(f.actor, last.proposal);
    expect(
      await service.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ status: 'reconciled' });
    expect(await balances(f)).toMatchObject({ '5121': '1000.00', '419': '0.00', '4427': '0.00' });
  });
  test('MCP prepares and revises partial refunds, waits for a human and rejects revoked cached execution', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale');
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '1084.70',
      'R,2026-02-01,-36.30,RON,Partial refund\n',
    );
    const candidate = await refund(
        f,
        p.proposal.id,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        { net: '30.00' },
      ),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Partial refund assistant',
        scopes: [
          'advances.proposeRefund',
          'advances.reviseRefund',
          'advances.getPayment',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'partial-refund-contract', version: '1' },
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
    const invoke = (name: string, input: unknown, idempotencyKey = key()) =>
      client.callTool({ name, arguments: { input, idempotencyKey } });
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('books.approve');
      const draft = proposalOutput.parse(
        (await invoke('advances.proposeRefund', candidate.input)).structuredContent,
      );
      const revised = proposalOutput.parse(
        (
          await invoke('advances.reviseRefund', {
            ...candidate.input,
            id: draft.id,
            version: draft.version,
            reason: 'Recheck the separately agreed partial amount before human approval',
          })
        ).structuredContent,
      );
      expect((await invoke('ledger.post', exact(revised))).isError).toBe(true);
      await service.books.approve(f.actor, key(), revised.id, review(revised));
      const commandKey = key();
      expect((await invoke('ledger.post', exact(revised), commandKey)).isError).not.toBe(true);
      expect(
        advancePaymentOutput.parse(
          (await invoke('advances.getPayment', { id: p.proposal.id, date: '2026-02-28' }))
            .structuredContent,
        ),
      ).toMatchObject({ status: 'open', remainingGross: '84.70' });
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(invoke('ledger.post', exact(revised), commandKey)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
  test('partial refund records, remaining controls, sources and cached commands survive export and fresh restore', async () => {
    const f = await fixture(),
      p = await bankAdvance(f);
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '915.30',
      'R,2026-02-01,36.30,RON,Partial return\n',
    );
    const r = await refund(
        f,
        p.proposal.id,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        { net: '30.00' },
      ),
      executionKey = key(),
      posted = await post(f.actor, r.proposal, executionKey),
      state = await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
      job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.advanceRefunds).toHaveLength(1);
    await backup(db, objects, join(directory, 'partial-backup'));
    const restored = await restore(
        join(directory, 'partial-backup'),
        join(directory, 'partial-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
      ).toEqual(state);
      expect(await copy.ledger.post(f.actor, executionKey, exact(r.proposal))).toEqual(
        posted.entry,
      );
      expect((await copy.documents.read(f.actor, r.agreement.id)).bytes).toEqual(
        (await service.documents.read(f.actor, r.agreement.id)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(advanceRefunds)
          .where(eq(advanceRefunds.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });
});

describe('partial refunds across accounting and tax periods', () => {
  test.each(['purchase', 'sale'] as const)(
    '%s: a new-year refund retains the earlier refund, requires explicit opening continuity and invoices only the remainder',
    async (direction) => {
      const f = await fixture('normal_vat', 2025),
        purchase = direction === 'purchase',
        oldClosing = purchase ? '915.30' : '1084.70';
      await statement(
        f,
        '2025-12-01',
        '2025-12-31',
        '1000.00',
        oldClosing,
        `P,2025-12-10,${purchase ? '-' : ''}121.00,RON,old-advance\nR,2025-12-20,${purchase ? '' : '-'}36.30,RON,old-refund\n`,
      );
      const rows = (await service.queries.movements(f.actor, { matched: false })).items,
        p = await service.advances.proposePayment(
          f.actor,
          key(),
          paymentInput(f, rows.find((row) => row.reference === 'old-advance')!.id, direction, {
            evidenceDate: '2025-12-01',
            serviceExpectedOn: '2026-03-31',
          }),
        );
      await post(f.actor, p);
      const old = await refund(f, p.id, rows.find((row) => row.reference === 'old-refund')!.id, {
          net: '30.00',
          decisionDate: '2025-12-20',
        }),
        oldEntry = await post(f.actor, old.proposal),
        year = await service.foundation.createYear(f.actor, key(), {
          kind: 'financial',
          label: '2026',
          from: '2026-01-01',
          to: '2026-12-31',
        }),
        next = { ...f, financialYear: year };
      expect(
        await service.advances.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-01' }),
      ).toMatchObject({ status: 'needs_review' });
      await post(
        f.actor,
        await service.ledger.propose(f.actor, key(), {
          financialYearId: year.id,
          evidenceId: f.proof.id,
          date: '2026-01-01',
          purpose: 'opening',
          description: 'Independently documented reduced advance carry',
          sourceReference: 'opening-2026',
          lines: purchase
            ? [
                { account: '5121', debit: oldClosing, credit: '0.00' },
                { account: '4092', debit: '84.70', credit: '0.00' },
                { account: '1012', debit: '0.00', credit: '1000.00' },
              ]
            : [
                { account: '5121', debit: oldClosing, credit: '0.00' },
                { account: '419', debit: '0.00', credit: '70.00' },
                { account: '4427', debit: '0.00', credit: '14.70' },
                { account: '1012', debit: '0.00', credit: '1000.00' },
              ],
        }),
      );
      const closing = purchase ? '939.50' : '1060.50';
      await statement(
        next,
        '2026-01-01',
        '2026-01-31',
        oldClosing,
        closing,
        `R2,2026-01-01,${purchase ? '' : '-'}24.20,RON,new-refund\n`,
      );
      const r = await refund(
          next,
          p.id,
          (await service.queries.movements(f.actor, { matched: false })).items[0].id,
          { net: '20.00', decisionDate: '2026-01-01' },
        ),
        effect = generalBodySchema.parse(r.proposal.body).advanceRefund!;
      expect(effect).toMatchObject({
        originalFinancialYearId: f.financialYear.id,
        originalTaxPointDate: '2025-12-10',
        net: '20.00',
        tax: '4.20',
        refundBasis: {
          priorRefundJournalId: oldEntry.entry.id,
          priorRefundFinancialYearId: f.financialYear.id,
          priorRefundCount: 1,
          after: { gross: '60.50' },
        },
      });
      await post(f.actor, r.proposal);
      expect(
        await service.advances.getPayment(f.actor, { id: p.id, date: '2025-12-31' }),
      ).toMatchObject({ remainingGross: '84.70', refundedGross: '36.30' });
      expect(
        await service.advances.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-31' }),
      ).toMatchObject({ status: 'reconciled' });
      expect(await service.vat.summary(f.actor, { financialYearId: year.id })).toMatchObject({
        status: 'reconciled',
        totals: { outputTax: purchase ? '0.00' : '-4.20', inputTax: '0.00' },
      });
      expect(
        (await service.vat.summary(f.actor, { financialYearId: f.financialYear.id })).totals
          .outputTax,
      ).toBe(purchase ? '0.00' : '14.70');
      const invoice = await invoiced(
        next,
        {
          direction,
          date: '2026-02-01',
          taxPointDate: '2025-12-10',
          net: '50.00',
          tax: '10.50',
          gross: '60.50',
        },
        {
          taxPointDate: '2025-12-10',
          account: purchase ? '628' : '704',
          deduction: purchase ? 'full' : 'none',
          paymentIds: [p.id],
        },
      );
      expect(
        await service.positions.read(f.actor, {
          invoiceId: invoice.invoice.id,
          date: '2026-02-01',
        }),
      ).toMatchObject({ balance: '0.00' });
      expect(
        await service.advances.getPayment(f.actor, { id: p.id, date: '2026-02-01' }),
      ).toMatchObject({ status: 'invoiced', remainingGross: '0.00' });
      expect(await service.vat.summary(f.actor, { financialYearId: year.id })).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: purchase ? '10.50' : '0.00', outputTax: purchase ? '0.00' : '-4.20' },
      });
    },
  );
  test('a partial refund after the 2025 rate change retains the original 19 percent tax and exact remaining invoice', async () => {
    const f = await fixture('normal_vat', 2025);
    await statement(
      f,
      '2025-07-01',
      '2025-07-31',
      '1000.00',
      '881.00',
      'P,2025-07-10,-119.00,RON,Old rate advance\n',
    );
    const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
      p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, movement.id, 'purchase', {
          evidenceDate: '2025-07-01',
          serviceExpectedOn: '2025-12-31',
        }),
      );
    await post(f.actor, p);
    await statement(
      f,
      '2025-08-01',
      '2025-08-31',
      '881.00',
      '916.70',
      'R,2025-08-01,35.70,RON,Partial old rate return\n',
    );
    const r = await refund(
      f,
      p.id,
      (await service.queries.movements(f.actor, { matched: false })).items[0].id,
      { net: '30.00', decisionDate: '2025-08-01' },
    );
    expect(generalBodySchema.parse(r.proposal.body).advanceRefund).toMatchObject({
      net: '30.00',
      tax: '5.70',
      gross: '35.70',
      originalTaxPointDate: '2025-07-10',
      refundBasis: { after: { net: '70.00', tax: '13.30', gross: '83.30' } },
    });
    await post(f.actor, r.proposal);
    const invoice = await invoiced(
      f,
      {
        date: '2025-08-01',
        taxPointDate: '2025-07-10',
        rate: '19',
        net: '70.00',
        tax: '13.30',
        gross: '83.30',
      },
      {
        recognitionDate: '2025-08-01',
        taxPointDate: '2025-07-10',
        evidenceDate: '2025-07-01',
        serviceExpectedOn: '2025-12-31',
        paymentIds: [p.id],
      },
    );
    expect(
      await service.positions.read(f.actor, { invoiceId: invoice.invoice.id, date: '2025-08-31' }),
    ).toMatchObject({ balance: '0.00' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '13.30' } });
  });
});

test('a posted invoice blocks an earlier approved partial refund and retains its unmatched bank movement', async () => {
  const f = await fixture(),
    p = await bankAdvance(f, 'sale');
  await statement(
    f,
    '2026-02-01',
    '2026-02-28',
    p.closing,
    '1084.70',
    'R,2026-02-01,-36.30,RON,Recorded bank refund\n',
  );
  const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
    r = await refund(f, p.proposal.id, movement.id, { net: '30.00' });
  await service.books.approve(f.actor, key(), r.proposal.id, review(r.proposal));
  await invoiced(
    f,
    { direction: 'sale', taxPointDate: '2026-01-10' },
    { taxPointDate: '2026-01-10', account: '704', deduction: 'none', paymentIds: [p.proposal.id] },
  );
  await expect(service.ledger.post(f.actor, key(), exact(r.proposal))).rejects.toMatchObject({
    code: 'ADVANCE_PAYMENT_RESOLVED',
  });
  expect(
    (await service.queries.movements(f.actor, { matched: false })).items.map((row) => row.id),
  ).toContain(movement.id);
  expect(
    await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
  ).toMatchObject({ status: 'invoiced', remainingGross: '0.00', refundJournalId: null });
});

test.each([
  {
    vat: 'normal_vat' as const,
    axis: 'vat',
    middle: 'non_vat',
    end: 'normal_vat',
    gross: '36.30',
    closing: '915.30',
  },
  {
    vat: 'normal_vat' as const,
    axis: 'vat_collection',
    middle: 'yes',
    end: 'no',
    gross: '36.30',
    closing: '915.30',
  },
  {
    vat: 'non_vat' as const,
    axis: 'vat',
    middle: 'normal_vat',
    end: 'non_vat',
    gross: '30.00',
    closing: '930.00',
  },
])(
  '$vat $axis: matching endpoint registrations cannot hide an intermediate unsupported regime',
  async (c) => {
    const f = await fixture(c.vat),
      p = await bankAdvance(f, 'purchase');
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      c.closing,
      `R,2026-02-01,${c.gross},RON,Refund after registration changes\n`,
    );
    for (const [date, value] of [
      ['2026-01-15', c.middle],
      ['2026-01-20', c.end],
    ])
      await service.foundation.recordRegime(f.actor, key(), {
        axis: c.axis,
        value,
        effectiveFrom: date,
        evidenceId: f.proof.id,
      });
    await expect(
      refund(
        f,
        p.proposal.id,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        { net: '30.00' },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_REGISTRATION_TRANSITION' });
  },
);
