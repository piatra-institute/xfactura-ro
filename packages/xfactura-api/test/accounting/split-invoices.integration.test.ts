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
  secret = 'synthetic-split-invoice-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-split-invoices-'));
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
        email: 'split-invoices@example.test',
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

type Portion = {
  net: string;
  tax: string;
  gross: string;
  date?: string;
  direction?: 'purchase' | 'sale';
  category?: 'S' | 'O';
  deduction?: 'full' | 'none';
  whole?: boolean;
  taxPointDate?: string;
};
async function portion(
  f: Fixture,
  paymentId: string,
  value: Portion,
  changes: Partial<AdvanceInvoiceInput> = {},
) {
  const direction = value.direction ?? 'purchase',
    date = value.date ?? '2026-02-01',
    invoice = await imported(f, {
      number: key(),
      direction,
      date,
      net: value.net,
      tax: value.tax,
      gross: value.gross,
      category: value.category ?? 'S',
      taxPointDate: value.taxPointDate ?? '2026-01-10',
    }),
    request = advanceInput(f, invoice.id, {
      recognitionDate: date,
      taxPointDate: value.taxPointDate ?? '2026-01-10',
      account: direction === 'purchase' ? '628' : '704',
      deduction: value.deduction ?? 'full',
      paymentIds: value.whole ? [paymentId] : [],
      ...(value.whole ? {} : { paymentAllocations: [{ paymentId, net: value.net }] }),
      ...changes,
    }),
    proposal = await service.advances.proposeInvoice(f.actor, key(), request);
  return { invoice, request, proposal };
}

describe('one advance payment across multiple invoices', () => {
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
    '$vat $direction $category $deduction: two invoiced parts, unused refund and final service reconcile exactly',
    async (c) => {
      const f = await fixture(c.vat),
        p = await bankAdvance(f, c.direction, c.category),
        tax = c.category === 'S',
        a = await portion(f, p.proposal.id, {
          ...c,
          net: '30.00',
          tax: tax ? '6.30' : '0.00',
          gross: tax ? '36.30' : '30.00',
        });
      const effect = generalBodySchema.parse(a.proposal.body).invoice!.advance!.payments[0];
      expect(effect.allocation).toEqual({
        requestedNet: '30.00',
        priorInvoiceCount: 0,
        priorRefundCount: 0,
        before: { net: '100.00', tax: tax ? '21.00' : '0.00', gross: p.gross },
        after: { net: '70.00', tax: tax ? '14.70' : '0.00', gross: tax ? '84.70' : '70.00' },
      });
      const firstEntry = await post(f.actor, a.proposal);
      expect(
        advancePaymentOutput.parse(
          await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
        ),
      ).toMatchObject({
        status: 'open',
        remainingGross: tax ? '84.70' : '70.00',
        invoicedNet: '30.00',
        invoices: [{ invoiceId: a.invoice.id, journalId: firstEntry.entry.id }],
      });
      expect(
        (
          await service.advances.payments(f.actor, { date: '2026-02-28', onlyOpen: true })
        ).items.map((row) => row.id),
      ).toContain(p.proposal.id);
      expect(
        await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2026-02-28' }),
      ).toMatchObject({ balance: '0.00' });
      await statement(f, '2026-02-01', '2026-02-28', p.closing, p.closing);
      await service.periods.close(f.actor, key(), '2026-02-01');
      const b = await portion(f, p.proposal.id, {
        ...c,
        date: '2026-03-01',
        net: '50.00',
        tax: tax ? '10.50' : '0.00',
        gross: tax ? '60.50' : '50.00',
      });
      await post(f.actor, b.proposal);
      expect(
        generalBodySchema.parse(b.proposal.body).invoice!.advance!.payments[0].allocation,
      ).toMatchObject({
        priorInvoiceCount: 1,
        before: { net: '70.00' },
        after: { net: '20.00', gross: tax ? '24.20' : '20.00' },
      });
      expect(
        await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
      ).toMatchObject({ remainingNet: '70.00', invoicedNet: '30.00' });
      expect(
        await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-03-31' }),
      ).toMatchObject({ remainingNet: '20.00', invoicedNet: '80.00', status: 'open' });
      const closing =
        c.direction === 'purchase' ? (tax ? '903.20' : '920.00') : tax ? '1096.80' : '1080.00';
      await statement(f, '2026-03-01', '2026-03-31', p.closing, p.closing);
      await statement(
        f,
        '2026-04-01',
        '2026-04-30',
        p.closing,
        closing,
        `R,2026-04-01,${c.direction === 'sale' ? '-' : ''}${tax ? '24.20' : '20.00'},RON,Return unused unbilled remainder\n`,
      );
      const r = await refund(
          f,
          p.proposal.id,
          (await service.queries.movements(f.actor, { matched: false })).items[0].id,
          { decisionDate: '2026-04-01' },
        ),
        refundEffect = generalBodySchema.parse(r.proposal.body).advanceRefund!;
      expect(refundEffect).toMatchObject({
        net: '20.00',
        tax: tax ? '4.20' : '0.00',
        refundBasis: {
          priorInvoiceCount: 2,
          priorInvoice: { invoiceId: b.invoice.id, financialYearId: f.financialYear.id },
          before: { net: '20.00' },
          after: { gross: '0.00' },
        },
      });
      await post(f.actor, r.proposal);
      expect(
        (await service.advances.payments(f.actor, { date: '2026-04-30', onlyOpen: true })).items,
      ).toHaveLength(0);
      const result = await final(
        f,
        { ...a, ...firstEntry },
        {
          date: '2026-05-10',
          net: '0.00',
          tax: '0.00',
          gross: '0.00',
          serviceNet: '80.00',
          advances: [
            { number: a.invoice.body.number, lineId: 'A1', net: '30.00' },
            { number: b.invoice.body.number, lineId: 'A2', net: '50.00' },
          ],
        },
        {
          recognitionDate: '2026-05-10',
          serviceDate: '2026-05-10',
          taxPointDate: '2026-05-10',
          allocations: [
            {
              advanceInvoiceId: a.invoice.id,
              lineId: 'A1',
              net: '30.00',
              tax: tax ? '6.30' : '0.00',
            },
            {
              advanceInvoiceId: b.invoice.id,
              lineId: 'A2',
              net: '50.00',
              tax: tax ? '10.50' : '0.00',
            },
          ],
        },
      );
      await post(f.actor, result.proposal);
      expect(
        await service.advances.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-05-31',
        }),
      ).toMatchObject({
        status: 'reconciled',
        supplier: { remaining: '0.00' },
        customer: { remaining: '0.00' },
      });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: c.direction === 'purchase' && c.deduction === 'full' ? '16.80' : '0.00',
          outputTax: c.direction === 'sale' && tax ? '16.80' : '0.00',
        },
      });
      expect(await balances(f)).toMatchObject({
        '5121': closing,
        [c.direction === 'purchase' ? '628' : '704']:
          c.direction === 'sale' ? '-80.00' : tax && c.deduction === 'none' ? '96.80' : '80.00',
      });
    },
  );
  test('a full remaining paymentIds allocation after a partial invoice preserves the first invoice', async () => {
    const f = await fixture(),
      p = await bankAdvance(f),
      a = await portion(f, p.proposal.id, { net: '30.00', tax: '6.30', gross: '36.30' });
    await post(f.actor, a.proposal);
    const b = await portion(f, p.proposal.id, {
        date: '2026-03-01',
        net: '70.00',
        tax: '14.70',
        gross: '84.70',
        whole: true,
      }),
      body = generalBodySchema.parse(b.proposal.body);
    expect(body.invoice!.advance!.payments[0].allocation).toMatchObject({
      requestedNet: null,
      priorInvoiceCount: 1,
      after: { gross: '0.00' },
    });
    await post(f.actor, b.proposal);
    expect(
      await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-03-31' }),
    ).toMatchObject({ status: 'invoiced', invoicedGross: '121.00', remainingGross: '0.00' });
    expect(
      (await db.orm.select().from(proposals).where(eq(proposals.id, a.proposal.id)))[0].hash,
    ).toBe(a.proposal.hash);
    expect(
      await service.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-03-31',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });
});

describe('split advance authority and exact history', () => {
  test('competing invoice approvals become stale and a revised allocation needs new approval', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale'),
      value: Portion = {
        direction: 'sale',
        deduction: 'none',
        net: '30.00',
        tax: '6.30',
        gross: '36.30',
      },
      first = await portion(f, p.proposal.id, value),
      second = await portion(f, p.proposal.id, value);
    await service.books.approve(f.actor, key(), second.proposal.id, review(second.proposal));
    await post(f.actor, first.proposal);
    await expect(service.ledger.post(f.actor, key(), exact(second.proposal))).rejects.toMatchObject(
      { code: 'STALE_ADVANCE_INVOICE' },
    );
    await expect(
      rawRefund(f, generalBodySchema.parse(second.proposal.body), () => {}).catch((e) => {
        throw e.cause ?? e;
      }),
    ).rejects.toThrow('invalid_or_stale_advance_invoice');
    const revised = await service.advances.proposeInvoice(f.actor, key(), second.request, {
      id: second.proposal.id,
      version: second.proposal.version,
    });
    expect(
      generalBodySchema.parse(revised.body).invoice!.advance!.payments[0].allocation,
    ).toMatchObject({
      priorInvoiceCount: 1,
      before: { gross: '84.70' },
      after: { gross: '48.40' },
    });
    await expect(service.ledger.post(f.actor, key(), exact(revised))).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await post(f.actor, revised);
    expect(
      await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({ remainingGross: '48.40', invoicedGross: '72.60', status: 'open' });
  });

  test('a later refund invalidates an approved invoice even when enough net remains', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale'),
      a = await portion(f, p.proposal.id, {
        direction: 'sale',
        deduction: 'none',
        net: '30.00',
        tax: '6.30',
        gross: '36.30',
      });
    await post(f.actor, a.proposal);
    const b = await portion(f, p.proposal.id, {
      direction: 'sale',
      deduction: 'none',
      net: '30.00',
      tax: '6.30',
      gross: '36.30',
    });
    await service.books.approve(f.actor, key(), b.proposal.id, review(b.proposal));
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '1096.80',
      'R,2026-02-01,-24.20,RON,Unused part\n',
    );
    const r = await refund(
      f,
      p.proposal.id,
      (await service.queries.movements(f.actor, { matched: false })).items[0].id,
      { net: '20.00' },
    );
    await post(f.actor, r.proposal);
    await expect(service.ledger.post(f.actor, key(), exact(b.proposal))).rejects.toMatchObject({
      code: 'STALE_ADVANCE_INVOICE',
    });
    await expect(
      rawRefund(f, generalBodySchema.parse(b.proposal.body), () => {}).catch((e) => {
        throw e.cause ?? e;
      }),
    ).rejects.toThrow('invalid_or_stale_advance_invoice');
    expect(
      await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({ remainingGross: '60.50', invoicedGross: '36.30', refundedGross: '24.20' });
  });

  test('independent SQLite guards reject forged partial-invoice budgets, lineage, tax and balanced effects', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale'),
      a = await portion(f, p.proposal.id, {
        direction: 'sale',
        deduction: 'none',
        net: '30.00',
        tax: '6.30',
        gross: '36.30',
      });
    await post(f.actor, a.proposal);
    const b = await portion(f, p.proposal.id, {
        direction: 'sale',
        deduction: 'none',
        net: '20.00',
        tax: '4.20',
        gross: '24.20',
      }),
      base = generalBodySchema.parse(b.proposal.body),
      mutations: Array<(body: GeneralBody) => void> = [
        (b) => {
          Reflect.deleteProperty(b.invoice!.advance!.payments[0], 'allocation');
        },
        (b) => {
          b.invoice!.advance!.payments[0].allocation!.before.gross = '121.00';
        },
        (b) => {
          b.invoice!.advance!.payments[0].allocation!.after.net = '70.00';
        },
        (b) => {
          b.invoice!.advance!.payments[0].allocation!.priorInvoiceCount = 0;
        },
        (b) => {
          b.invoice!.advance!.payments[0].allocation!.priorRefundCount = 1;
        },
        (b) => {
          b.invoice!.advance!.payments[0].allocation!.requestedNet = null;
        },
        (b) => {
          b.invoice!.advance!.payments[0].allocation!.requestedNet = '21.00';
        },
        (b) => {
          b.invoice!.advance!.payments[0].tax = '0.00';
        },
        (b) => {
          b.invoice!.advance!.payments[0].movementId = key();
        },
        (b) => {
          b.lines[0].account = '704';
        },
      ];
    for (const mutation of mutations)
      await expect(
        rawRefund(f, base, mutation).catch((e) => {
          throw e.cause ?? e;
        }),
      ).rejects.toThrow('invalid_or_stale_advance_invoice');
    await post(f.actor, b.proposal);
    const rows = await db.orm
      .select()
      .from(advanceInvoiceMatches)
      .where(eq(advanceInvoiceMatches.companyId, f.company.id));
    expect(rows).toHaveLength(2);
    await expect(
      db.orm
        .delete(advanceInvoiceMatches)
        .where(eq(advanceInvoiceMatches.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(advanceInvoiceMatches)
        .set({ netBani: 1n })
        .where(eq(advanceInvoiceMatches.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
  });

  test('refunds retain prior-invoice lineage and native guards reject invented history and reused source evidence', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'sale'),
      a = await portion(f, p.proposal.id, {
        direction: 'sale',
        deduction: 'none',
        net: '30.00',
        tax: '6.30',
        gross: '36.30',
      });
    await post(f.actor, a.proposal);
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      p.closing,
      '1036.30',
      'R,2026-02-02,-84.70,RON,Unbilled remainder\n',
    );
    const r = await refund(
        f,
        p.proposal.id,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        { decisionDate: '2026-02-02' },
      ),
      base = generalBodySchema.parse(r.proposal.body),
      xmlHash = sha256((await service.documents.read(f.actor, a.invoice.evidenceId)).bytes),
      mutations: Array<(b: GeneralBody) => void> = [
        (b) => {
          Reflect.deleteProperty(b.advanceRefund!.refundBasis!, 'priorInvoice');
        },
        (b) => {
          b.advanceRefund!.refundBasis!.priorInvoiceCount = 2;
        },
        (b) => {
          b.advanceRefund!.refundBasis!.priorInvoice!.journalId = p.entry.id;
        },
        (b) => {
          b.advanceRefund!.refundBasis!.priorInvoice!.invoiceId = key();
        },
        (b) => {
          b.advanceRefund!.refundBasis!.before.gross = '121.00';
        },
        (b) => {
          b.advanceRefund!.evidenceId = a.invoice.evidenceId;
          b.advanceRefund!.evidenceHash = xmlHash;
        },
      ];
    for (const mutation of mutations)
      await expect(
        rawRefund(f, base, mutation).catch((e) => {
          throw e.cause ?? e;
        }),
      ).rejects.toThrow('invalid_or_resolved_advance_refund');
    for (const evidenceId of [a.invoice.evidenceId, f.proof.id])
      await expect(
        service.advances.proposeRefund(f.actor, key(), { ...r.input, evidenceId }),
      ).rejects.toMatchObject({ code: 'ADVANCE_REFUND_EVIDENCE' });
    const overview = await service.overview(f.actor, f.financialYear.id);
    expect(overview.invoiceLabels[a.invoice.id].number).toBe(a.invoice.body.number);
    await post(f.actor, r.proposal);
    expect(
      await service.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('mixed modes, duplicate sources, zero/excess amounts, wrong totals and other-company sources fail closed', async () => {
    const f = await fixture(),
      p = await bankAdvance(f),
      a = await portion(f, p.proposal.id, { net: '30.00', tax: '6.30', gross: '36.30' });
    for (const [changes, code] of [
      [{ paymentIds: [p.proposal.id] }, 'ADVANCE_ALLOCATION_MODE'],
      [
        {
          paymentAllocations: [
            { paymentId: p.proposal.id, net: '15.00' },
            { paymentId: p.proposal.id, net: '15.00' },
          ],
        },
        'DUPLICATE_ALLOCATION',
      ],
      [
        { paymentAllocations: [{ paymentId: p.proposal.id, net: '0.00' }] },
        'ADVANCE_PAYMENT_AMOUNT',
      ],
      [
        { paymentAllocations: [{ paymentId: p.proposal.id, net: '100.01' }] },
        'ADVANCE_PAYMENT_AMOUNT',
      ],
      [
        { paymentAllocations: [{ paymentId: p.proposal.id, net: '29.00' }] },
        'ADVANCE_INVOICE_TOTAL',
      ],
    ] as Array<[Partial<AdvanceInvoiceInput>, string]>)
      await expect(
        service.advances.proposeInvoice(f.actor, key(), { ...a.request, ...changes }),
      ).rejects.toMatchObject({ code });
    const other = await fixture();
    await expect(
      portion(other, p.proposal.id, { net: '30.00', tax: '6.30', gross: '36.30' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await post(f.actor, a.proposal);
    await expect(
      portion(f, p.proposal.id, { net: '71.00', tax: '14.91', gross: '85.91' }),
    ).rejects.toMatchObject({ code: 'ADVANCE_PAYMENT_AMOUNT' });
  });

  test('dated pages keep a partly invoiced source open and do not permit backdating past its later invoice', async () => {
    const f = await fixture(),
      p = await bankAdvance(f, 'purchase', 'S', { serviceExpectedOn: '2026-06-30' }),
      a = await portion(
        f,
        p.proposal.id,
        { net: '30.00', tax: '6.30', gross: '36.30', date: '2026-03-01' },
        { serviceExpectedOn: '2026-06-30' },
      );
    await post(f.actor, a.proposal);
    await expect(
      portion(f, p.proposal.id, { net: '20.00', tax: '4.20', gross: '24.20', date: '2026-02-01' }),
    ).rejects.toMatchObject({ code: 'ADVANCE_INVOICE_ORIGIN' });
    for (const date of ['2026-02-28', '2026-03-31']) {
      const page = await service.advances.payments(f.actor, { date, onlyOpen: true, limit: 1 });
      expect(page.items.map((row) => row.id)).toEqual([p.proposal.id]);
      expect(page.items[0].remainingGross).toBe(date === '2026-02-28' ? '121.00' : '84.70');
    }
    const b = await portion(
      f,
      p.proposal.id,
      { net: '70.00', tax: '14.70', gross: '84.70', date: '2026-04-01', whole: true },
      { serviceExpectedOn: '2026-06-30' },
    );
    await post(f.actor, b.proposal);
    expect(
      (await service.advances.payments(f.actor, { date: '2026-03-31', onlyOpen: true })).items,
    ).toHaveLength(1);
    expect(
      (await service.advances.payments(f.actor, { date: '2026-04-30', onlyOpen: true })).items,
    ).toHaveLength(0);
  });

  test('one invoice can consume specified parts of two advances without closing either remainder', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '1242.00',
      'A,2026-01-10,121.00,RON,first\nB,2026-01-10,121.00,RON,second\n',
    );
    const rows = (await service.queries.movements(f.actor, { matched: false })).items,
      payments: Array<{ id: string; version: number; hash: string }> = [];
    for (const row of rows) {
      const p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, row.id, 'sale'),
      );
      await post(f.actor, p);
      payments.push(p);
    }
    const a = await portion(
      f,
      payments[0].id,
      { direction: 'sale', deduction: 'none', net: '60.00', tax: '12.60', gross: '72.60' },
      { paymentAllocations: payments.map((p) => ({ paymentId: p.id, net: '30.00' })) },
    );
    await post(f.actor, a.proposal);
    expect(
      (await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2026-02-28' }))
        .balance,
    ).toBe('0.00');
    for (const p of payments)
      expect(
        await service.advances.getPayment(f.actor, { id: p.id, date: '2026-02-28' }),
      ).toMatchObject({ status: 'open', remainingGross: '84.70', invoicedGross: '36.30' });
    expect(
      await service.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({
      status: 'reconciled',
      customer: { ledger: '200.00', remaining: '200.00', difference: '0.00' },
    });
  });

  test('cent-size invoices leave original VAT for the final residual refund', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '1000.04',
      'P,2026-01-10,0.04,RON,tiny\n',
    );
    const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
      p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, movement.id, 'sale', { net: '0.03' }),
      );
    await post(f.actor, p);
    for (const date of ['2026-02-01', '2026-02-02']) {
      const a = await portion(f, p.id, {
        direction: 'sale',
        deduction: 'none',
        net: '0.01',
        tax: '0.00',
        gross: '0.01',
        date,
      });
      await post(f.actor, a.proposal);
    }
    expect(
      await service.advances.getPayment(f.actor, { id: p.id, date: '2026-02-28' }),
    ).toMatchObject({ remainingNet: '0.01', remainingTax: '0.01', remainingGross: '0.02' });
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      '1000.04',
      '1000.02',
      'R,2026-02-03,-0.02,RON,tiny-remainder\n',
    );
    const r = await refund(
      f,
      p.id,
      (await service.queries.movements(f.actor, { matched: false })).items[0].id,
      { decisionDate: '2026-02-03' },
    );
    expect(generalBodySchema.parse(r.proposal.body).advanceRefund!.tax).toBe('0.01');
    await post(f.actor, r.proposal);
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { outputTax: '0.00' } });
  });

  test('partial invoice amounts remain exact beyond Number precision', async () => {
    const f = await fixture();
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '121000000002209.94',
      'P,2026-01-10,121000000001209.94,RON,large\n',
    );
    const movement = (await service.queries.movements(f.actor, { matched: false })).items[0],
      p = await service.advances.proposePayment(
        f.actor,
        key(),
        paymentInput(f, movement.id, 'sale', { net: '100000000000999.95' }),
      );
    await post(f.actor, p);
    const a = await portion(f, p.id, {
      direction: 'sale',
      deduction: 'none',
      net: '100000000000900.01',
      tax: '21000000000189.00',
      gross: '121000000001089.01',
    });
    await post(f.actor, a.proposal);
    expect(
      await service.advances.getPayment(f.actor, { id: p.id, date: '2026-02-28' }),
    ).toMatchObject({ remainingNet: '99.94', remainingTax: '20.99', remainingGross: '120.93' });
    const b = await portion(f, p.id, {
      direction: 'sale',
      deduction: 'none',
      net: '99.94',
      tax: '20.99',
      gross: '120.93',
      date: '2026-03-01',
      whole: true,
    });
    await post(f.actor, b.proposal);
    expect(
      await service.advances.getPayment(f.actor, { id: p.id, date: '2026-03-31' }),
    ).toMatchObject({
      remainingGross: '0.00',
      invoicedGross: '121000000001209.94',
      status: 'invoiced',
    });
    expect(
      await service.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-03-31',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });
});

test('MCP exposes explicit invoice allocations and preserves human approval and revoked retry authority', async () => {
  const f = await fixture(),
    p = await bankAdvance(f, 'sale'),
    candidate = await portion(f, p.proposal.id, {
      direction: 'sale',
      deduction: 'none',
      net: '30.00',
      tax: '6.30',
      gross: '36.30',
    }),
    grant = await service.agents.issue(f.actor, key(), {
      name: 'Split advance assistant',
      scopes: [
        'advances.proposeInvoice',
        'advances.reviseInvoice',
        'advances.getPayment',
        'ledger.post',
      ],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    publicUrl = 'http://localhost:3000',
    app = createApp(service, { publicUrl, authSecret: secret }).app,
    client = new Client(
      { name: 'split-advance-contract', version: '1' },
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
        (await invoke('advances.proposeInvoice', candidate.request)).structuredContent,
      ),
      revised = proposalOutput.parse(
        (
          await invoke('advances.reviseInvoice', {
            ...candidate.request,
            id: draft.id,
            version: draft.version,
            reason: 'Review this allocation before consuming the remaining bank advance',
          })
        ).structuredContent,
      );
    expect((await invoke('ledger.post', exact(revised))).isError).toBe(true);
    await service.books.approve(f.actor, key(), revised.id, review(revised));
    const executionKey = key();
    expect((await invoke('ledger.post', exact(revised), executionKey)).isError).not.toBe(true);
    const result = advancePaymentOutput.parse(
      (await invoke('advances.getPayment', { id: p.proposal.id, date: '2026-02-28' }))
        .structuredContent,
    );
    expect(result).toMatchObject({
      remainingGross: '84.70',
      invoicedGross: '36.30',
      status: 'open',
    });
    expect(result.invoices).toHaveLength(1);
    await service.agents.revoke(f.actor, key(), grant.id);
    await expect(invoke('ledger.post', exact(revised), executionKey)).rejects.toThrow();
  } finally {
    await client.close();
  }
});

test('multiple invoice matches, remaining controls, exact commands and original sources survive export and fresh restore', async () => {
  const f = await fixture(),
    p = await bankAdvance(f),
    a = await portion(f, p.proposal.id, { net: '30.00', tax: '6.30', gross: '36.30' });
  await post(f.actor, a.proposal);
  const b = await portion(f, p.proposal.id, { net: '20.00', tax: '4.20', gross: '24.20' }),
    executionKey = key(),
    posted = await post(f.actor, b.proposal, executionKey),
    state = await service.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
    job = await service.exports.request(f.actor, key());
  await runOneExport(db, objects);
  const exported = JSON.parse(
    Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
  ).data;
  expect(exported.advanceInvoiceMatches).toHaveLength(2);
  expect(exported.advanceInvoiceMatches.map((row: { paymentId: string }) => row.paymentId)).toEqual(
    [p.proposal.id, p.proposal.id],
  );
  await backup(db, objects, join(directory, 'split-backup'));
  const restored = await restore(
      join(directory, 'split-backup'),
      join(directory, 'split-restored'),
    ),
    copyDb = new Database(restored.databaseUrl);
  try {
    await migrate(copyDb);
    const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
    expect(
      await copy.advances.getPayment(f.actor, { id: p.proposal.id, date: '2026-02-28' }),
    ).toEqual(state);
    expect(await copy.ledger.post(f.actor, executionKey, exact(b.proposal))).toEqual(posted.entry);
    expect((await copy.documents.read(f.actor, a.invoice.evidenceId)).bytes).toEqual(
      (await service.documents.read(f.actor, a.invoice.evidenceId)).bytes,
    );
    expect(
      await copy.advances.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ status: 'reconciled' });
    await expect(
      copyDb.orm
        .delete(advanceInvoiceMatches)
        .where(eq(advanceInvoiceMatches.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
  } finally {
    await copyDb.close();
  }
});

test('successive invoices after the August 2025 rate change retain the original 19 percent advance', async () => {
  const f = await fixture('normal_vat', 2025);
  await statement(
    f,
    '2025-07-01',
    '2025-07-31',
    '1000.00',
    '881.00',
    'P,2025-07-10,-119.00,RON,Original rate\n',
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
  for (const [net, tax, gross, date] of [
    ['30.00', '5.70', '35.70', '2025-08-01'],
    ['70.00', '13.30', '83.30', '2025-09-01'],
  ]) {
    const invoice = await imported(f, {
        number: key(),
        date,
        taxPointDate: '2025-07-10',
        rate: '19',
        net,
        tax,
        gross,
      }),
      proposal = await service.advances.proposeInvoice(
        f.actor,
        key(),
        advanceInput(f, invoice.id, {
          recognitionDate: date,
          taxPointDate: '2025-07-10',
          evidenceDate: '2025-07-01',
          serviceExpectedOn: '2025-12-31',
          paymentAllocations: [{ paymentId: p.id, net }],
        }),
      );
    await post(f.actor, proposal);
  }
  expect(
    await service.advances.getPayment(f.actor, { id: p.id, date: '2025-09-30' }),
  ).toMatchObject({
    status: 'invoiced',
    invoicedNet: '100.00',
    invoicedTax: '19.00',
    remainingGross: '0.00',
  });
  expect(await service.vat.summary(f.actor, { financialYearId: f.financialYear.id })).toMatchObject(
    { status: 'reconciled', totals: { inputTax: '19.00' } },
  );
});

test.each(['purchase', 'sale'] as const)(
  '%s: split invoices across years require opening controls and preserve both years in their history',
  async (direction) => {
    const f = await fixture('normal_vat', 2025),
      purchase = direction === 'purchase',
      closing = purchase ? '879.00' : '1121.00';
    await statement(
      f,
      '2025-12-01',
      '2025-12-31',
      '1000.00',
      closing,
      `P,2025-12-10,${purchase ? '-' : ''}121.00,RON,Prior advance\n`,
    );
    const p = await service.advances.proposePayment(
      f.actor,
      key(),
      paymentInput(
        f,
        (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        direction,
        { evidenceDate: '2025-12-01', serviceExpectedOn: '2026-03-31' },
      ),
    );
    await post(f.actor, p);
    const a = await portion(
      f,
      p.id,
      {
        direction,
        deduction: purchase ? 'full' : 'none',
        net: '30.00',
        tax: '6.30',
        gross: '36.30',
        date: '2025-12-20',
        taxPointDate: '2025-12-10',
      },
      { evidenceDate: '2025-12-01', serviceExpectedOn: '2026-03-31' },
    );
    await post(f.actor, a.proposal);
    const year = await service.foundation.createYear(f.actor, key(), {
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
        description: 'Documented split advance carry',
        sourceReference: 'opening-2026',
        lines: purchase
          ? [
              { account: '5121', debit: closing, credit: '0.00' },
              { account: '4092', debit: '114.70', credit: '0.00' },
              { account: '4426', debit: '6.30', credit: '0.00' },
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
    const b = await portion(
      next,
      p.id,
      {
        direction,
        deduction: purchase ? 'full' : 'none',
        net: '70.00',
        tax: '14.70',
        gross: '84.70',
        date: '2026-01-10',
        taxPointDate: '2025-12-10',
        whole: true,
      },
      { evidenceDate: '2025-12-01' },
    );
    await post(next.actor, b.proposal);
    const state = await service.advances.getPayment(f.actor, { id: p.id, date: '2026-01-31' });
    expect(state.invoices?.map((row) => row.financialYearId)).toEqual([
      f.financialYear.id,
      year.id,
    ]);
    expect(state).toMatchObject({ remainingGross: '0.00', invoicedGross: '121.00' });
    expect(
      await service.advances.getPayment(f.actor, { id: p.id, date: '2025-12-31' }),
    ).toMatchObject({ remainingGross: '84.70', invoicedGross: '36.30', status: 'open' });
    expect(
      await service.advances.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-31' }),
    ).toMatchObject({ status: 'reconciled' });
  },
);
