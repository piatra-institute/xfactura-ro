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
import { proposalOutput } from '../../source/accounting/capability-contracts';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import {
  canonical,
  generalBodySchema,
  type GeneralBody,
  type DeferralInput,
  type DeferralDiscountInput,
} from '../../source/accounting/domain';
import {
  facts,
  proposals,
  journals,
  invoiceCredits,
  deferralCancellations,
  deferralReleases,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID(),
  review = (p: { id: string; version: number; hash: string }) => ({
    id: p.id,
    version: p.version,
    hash: p.hash,
  }),
  approvalReview = (p: { version: number; hash: string }) => ({ version: p.version, hash: p.hash }),
  secret = 'synthetic-discount-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-discounts-'));
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
        name: 'Discount reviewer',
        email: 'discounts@example.test',
        password: 'synthetic-discount-password',
      },
    })
  ).user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function source(actor: Actor, contents: string, filename = 'agreement.txt') {
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
  const approval = await service.books.approve(actor, key(), p.id, approvalReview(p));
  return { approval, entry: await service.ledger.post(actor, commandKey, review(p)) };
}
async function fixture(vat: 'normal_vat' | 'non_vat' = 'normal_vat', year = 2026) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Subscription discounts SRL',
      cui: '12345678',
      year,
    }),
    actor = { actorId: ownerId, companyId: company.id },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(
      actor,
      `Independent retained contract and registration evidence ${company.id}`,
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
      description: 'Documented opening',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  return { company, actor, financialYear, proof, vat, year };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function deferred(f: Fixture, xml: XmlInput = {}, change: Partial<DeferralInput> = {}) {
  const file = await source(
      f.actor,
      invoiceXml({ number: 'SUBSCRIPTION', date: `${f.year}-01-01`, ...xml }),
      'subscription.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  const request = {
    financialYearId: f.financialYear.id,
    invoiceId: invoice.id,
    recognitionDate: invoice.body.issueDate,
    evidenceId: f.proof.id,
    taxPointBasis: 'early_invoice' as const,
    account: invoice.direction === 'purchase' ? '628' : '704',
    deduction:
      f.vat === 'normal_vat' && invoice.direction === 'purchase'
        ? ('full' as const)
        : ('none' as const),
    counterpartyVatCollection: 'no' as const,
    basis: 'uniform_subscription' as const,
    method: 'equal_calendar_months' as const,
    serviceFrom: `${f.year}-01-01`,
    serviceTo: `${f.year}-03-31`,
    evidenceDate: invoice.body.issueDate,
    reason: 'Uniform subscription independently documented before invoicing',
    ...change,
  };
  const proposal = await service.deferrals.proposeInvoice(f.actor, key(), request);
  await post(f.actor, proposal);
  return { invoice, proposal };
}
type Root = Awaited<ReturnType<typeof deferred>>;
async function discount(
  f: Fixture,
  root: Root,
  xml: XmlInput = {},
  change: Partial<DeferralDiscountInput> = {},
) {
  const proof = await source(
      f.actor,
      `Separately agreed post-invoice commercial discount; services and schedule unchanged ${key()}`,
    ),
    file = await source(
      f.actor,
      invoiceXml({
        direction: root.invoice.direction,
        credit: true,
        number: key(),
        originalNumber: root.invoice.body.number,
        date: `${f.year}-02-05`,
        net: '20.00',
        tax: '4.20',
        gross: '24.20',
        ...xml,
      }),
      'discount.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  const request: DeferralDiscountInput = {
    financialYearId: f.financialYear.id,
    invoiceId: invoice.id,
    originalInvoiceId: root.invoice.id,
    recognitionDate: invoice.body.issueDate,
    decisionDate: invoice.body.issueDate,
    treatmentEvidenceId: proof.id,
    kind: 'commercial_discount',
    periodBasis: 'current_period_event',
    reason: 'A separately negotiated price discount, with the agreed services unchanged',
    servicesUnchanged: true,
    ...change,
  };
  return { invoice, proof, request };
}
async function release(f: Fixture, root: Root, month: string) {
  return post(
    f.actor,
    await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      month,
    }),
  );
}
async function balance(f: Fixture, to?: string) {
  return Object.fromEntries(
    (
      await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id, to })
    ).balances.map((row) => [row.account, row.closing]),
  );
}
async function statement(
  f: Fixture,
  from: string,
  to: string,
  opening: string,
  closing: string,
  rows = '',
) {
  const file = await source(
    f.actor,
    `movement_id,booking_date,amount,currency,reference\n${rows}`,
    'statement.csv',
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: file.id,
    bankAccount: 'RO00SUBSCRIPTION',
    statementId: key(),
    from,
    to,
    opening,
    closing,
  });
}
async function cancellation(
  f: Fixture,
  root: Root,
  from = '2026-03-01',
  amounts = { net: '33.34', tax: '7.00', gross: '40.34' },
) {
  const proof = await source(
      f.actor,
      `Separate written agreement to cancel remaining future service ${key()}`,
    ),
    file = await source(
      f.actor,
      invoiceXml({
        direction: root.invoice.direction,
        credit: true,
        number: key(),
        originalNumber: root.invoice.body.number,
        date: from,
        ...amounts,
      }),
      'cancellation.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  return service.deferrals.proposeCreditNote(f.actor, key(), {
    financialYearId: f.financialYear.id,
    invoiceId: invoice.id,
    originalInvoiceId: root.invoice.id,
    recognitionDate: from,
    decisionDate: from,
    treatmentEvidenceId: proof.id,
    kind: 'cancellation',
    periodBasis: 'current_period_event',
    reason: 'Separately agreed cancellation of future unprovided services',
    cancelFrom: from,
  });
}
async function injected(actor: Actor, body: GeneralBody) {
  return db.write(async (tx) => {
    const factId = key(),
      version = 1,
      hash = sha256(canonical({ kind: 'general', version, body, factId }));
    await tx.insert(facts).values({
      id: factId,
      companyId: actor.companyId,
      kind: 'general',
      evidenceId: body.evidenceId,
      body,
      createdBy: actor.actorId,
    });
    const [draft] = await tx
      .insert(proposals)
      .values({
        id: key(),
        companyId: actor.companyId,
        factId,
        kind: 'general',
        version,
        hash,
        body,
        sourceKey: key(),
        createdBy: actor.actorId,
      })
      .returning();
    return draft;
  });
}

describe('post-invoice commercial subscription discounts', () => {
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: a paid subscription, closed month, discount and refund preserve the original monthly plan',
    async ({ direction }) => {
      const f = await fixture(),
        root = await deferred(f, { direction }),
        pay = direction === 'purchase' ? '-121.00' : '121.00',
        afterPay = direction === 'purchase' ? '879.00' : '1121.00';
      await statement(
        f,
        '2026-01-01',
        '2026-01-31',
        '1000.00',
        afterPay,
        `PAY,2026-01-05,${pay},RON,Subscription\n`,
      );
      const movement = (await service.queries.movements(f.actor, { matched: false })).items[0];
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: movement.id,
          allocations: [{ invoiceId: root.invoice.id, amount: '121.00' }],
        }),
      );
      await release(f, root, '2026-01-01');
      await service.periods.close(f.actor, key(), '2026-01-01');
      const before = await service.deferrals.get(f.actor, {
          id: root.proposal.id,
          date: '2026-02-28',
        }),
        note = await discount(f, root),
        draft = await service.deferrals.proposeDiscount(f.actor, key(), note.request),
        body = generalBodySchema.parse(draft.body);
      expect(body.lines).toEqual(
        direction === 'purchase'
          ? [
              { account: '401', debit: '24.20', credit: '0.00' },
              { account: '609', debit: '0.00', credit: '20.00' },
              { account: '4426', debit: '0.00', credit: '4.20' },
            ]
          : [
              { account: '4111', debit: '0.00', credit: '24.20' },
              { account: '709', debit: '20.00', credit: '0.00' },
              { account: '4427', debit: '4.20', credit: '0.00' },
            ],
      );
      await expect(service.ledger.post(f.actor, key(), review(draft))).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
      const posted = await post(f.actor, draft);
      expect(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-28' }),
      ).toEqual(before);
      expect(
        await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-02-28' }),
      ).toMatchObject({ balance: '-24.20', status: 'refund_due' });
      const afterRefund = direction === 'purchase' ? '903.20' : '1096.80';
      await statement(
        f,
        '2026-02-01',
        '2026-02-28',
        afterPay,
        afterRefund,
        `REFUND,2026-02-10,${direction === 'purchase' ? '24.20' : '-24.20'},RON,Discount refund\n`,
      );
      const refund = (await service.queries.movements(f.actor, { matched: false })).items[0];
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: refund.id,
          allocations: [{ invoiceId: root.invoice.id, amount: '-24.20' }],
        }),
      );
      await release(f, root, '2026-02-01');
      await service.periods.close(f.actor, key(), '2026-02-01');
      await release(f, root, '2026-03-01');
      expect(await balance(f)).toMatchObject(
        direction === 'purchase'
          ? {
              '5121': '903.20',
              '401': '0.00',
              '471': '0.00',
              '628': '100.00',
              '609': '-20.00',
              '4426': '16.80',
            }
          : {
              '5121': '1096.80',
              '4111': '0.00',
              '472': '0.00',
              '704': '-100.00',
              '709': '20.00',
              '4427': '-16.80',
            },
      );
      expect(
        (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }))
          .allocated,
      ).toBe('100.00');
      expect(
        (await service.queries.journals(f.actor, {})).items.some(
          (row) => row.id === posted.entry.id,
        ),
      ).toBe(true);
      expect(
        await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          from: '2026-02-01',
          to: '2026-02-28',
        }),
      ).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: direction === 'purchase' ? '-4.20' : '0.00',
          outputTax: direction === 'sale' ? '-4.20' : '0.00',
        },
      });
    },
  );

  test.each([
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'O',
      tax: '0.00',
      gross: '20.00',
      amount: '20.00',
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      category: 'O',
      tax: '0.00',
      gross: '20.00',
      amount: '20.00',
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'S',
      tax: '4.20',
      gross: '24.20',
      amount: '24.20',
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      category: 'S',
      tax: '4.20',
      gross: '24.20',
      amount: '24.20',
    },
  ])(
    '$vat $direction $category: irrecoverable VAT remains in the separate discount amount',
    async ({ vat, direction, category, tax, gross, amount }) => {
      const f = await fixture(vat),
        root = await deferred(
          f,
          {
            direction,
            category,
            tax: category === 'O' ? '0.00' : '21.00',
            gross: category === 'O' ? '100.00' : '121.00',
          },
          { deduction: 'none' },
        ),
        before = await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-28' }),
        note = await discount(f, root, { category, tax, gross });
      const draft = await service.deferrals.proposeDiscount(f.actor, key(), note.request),
        body = generalBodySchema.parse(draft.body);
      expect(body.invoice!.deferralDiscount!.amount).toBe(amount);
      expect(body.lines).toHaveLength(2);
      await post(f.actor, draft);
      expect(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-28' }),
      ).toEqual(before);
      expect((await balance(f))[direction === 'purchase' ? '609' : '709']).toBe(
        direction === 'purchase' ? `-${amount}` : amount,
      );
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00', outputTax: '0.00' } });
    },
  );

  test('another discount invalidates the old approval while an unchanged monthly release remains executable', async () => {
    const f = await fixture(),
      root = await deferred(f),
      a = await discount(f, root),
      b = await discount(f, root, { net: '10.00', tax: '2.10', gross: '12.10' }),
      draftA = await service.deferrals.proposeDiscount(f.actor, key(), a.request),
      draftB = await service.deferrals.proposeDiscount(f.actor, key(), b.request);
    const oldApproval = await service.books.approve(
        f.actor,
        key(),
        draftA.id,
        approvalReview(draftA),
      ),
      monthly = await service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-03-01',
      });
    await service.books.approve(f.actor, key(), monthly.id, approvalReview(monthly));
    await post(f.actor, draftB);
    await expect(service.ledger.post(f.actor, key(), review(draftA))).rejects.toMatchObject({
      code: 'STALE_DEFERRAL_DISCOUNT',
    });
    const body = generalBodySchema.parse(draftA.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: draftA.id,
          approvalId: oldApproval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const revised = await service.deferrals.proposeDiscount(f.actor, key(), a.request, {
      id: draftA.id,
      version: draftA.version,
    });
    await expect(service.ledger.post(f.actor, key(), review(revised))).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await post(f.actor, revised);
    await service.ledger.post(f.actor, key(), review(monthly));
    expect((await balance(f))['609']).toBe('-30.00');
  });

  test('discount and later cancellation retain separate effects; an after-cancellation discount is bounded by the original credit capacity', async () => {
    const f = await fixture(),
      root = await deferred(f);
    await release(f, root, '2026-01-01');
    const note = await discount(f, root);
    await post(f.actor, await service.deferrals.proposeDiscount(f.actor, key(), note.request));
    const cancel = await cancellation(f, root);
    await post(f.actor, cancel);
    const later = await discount(f, root, {
        date: '2026-03-02',
        net: '10.00',
        tax: '2.10',
        gross: '12.10',
      }),
      draft = await service.deferrals.proposeDiscount(f.actor, key(), later.request);
    expect(
      generalBodySchema.parse(draft.body).invoice!.deferralDiscount!.cancellationJournalId,
    ).toBe(
      (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }))
        .cancellation!.journalId,
    );
    await post(f.actor, draft);
    await release(f, root, '2026-02-01');
    expect(await balance(f)).toMatchObject({
      '471': '0.00',
      '628': '66.66',
      '609': '-30.00',
      '401': '-44.36',
      '4426': '7.70',
    });
    const excessive = await discount(f, root, {
      date: '2026-03-03',
      net: '40.00',
      tax: '8.40',
      gross: '48.40',
    });
    await expect(
      service.deferrals.proposeDiscount(f.actor, key(), excessive.request),
    ).rejects.toMatchObject({ code: 'OVER_CREDIT' });
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-03-31',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('unsupported scope changes, source reuse, foreign evidence and annual/error decisions fail closed', async () => {
    const f = await fixture(),
      other = await fixture(),
      root = await deferred(f),
      note = await discount(f, root);
    for (const changed of [
      { servicesUnchanged: false },
      { kind: 'cancellation' },
      { periodBasis: 'prior_year_error' },
      { recognitionDate: '2026-02-04' },
    ])
      await expect(
        Promise.resolve().then(() =>
          service.deferrals.proposeDiscount(f.actor, key(), { ...note.request, ...changed }),
        ),
      ).rejects.toThrow();
    for (const evidenceId of [f.proof.id, root.invoice.evidenceId, note.invoice.evidenceId])
      await expect(
        service.deferrals.proposeDiscount(f.actor, key(), {
          ...note.request,
          treatmentEvidenceId: evidenceId,
        }),
      ).rejects.toMatchObject({ code: 'DEFERRAL_DISCOUNT_EVIDENCE' });
    await expect(
      service.deferrals.proposeDiscount(f.actor, key(), {
        ...note.request,
        treatmentEvidenceId: other.proof.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.deferrals.proposeDiscount(other.actor, key(), note.request),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.invoices.proposeCreditNote(f.actor, key(), note.request),
    ).rejects.toThrow();
  });

  test('a closed recognition month rejects a later discount without altering its original statement or releases', async () => {
    const f = await fixture(),
      root = await deferred(f);
    await release(f, root, '2026-01-01');
    await statement(f, '2026-01-01', '2026-01-31', '1000.00', '1000.00');
    await service.periods.close(f.actor, key(), '2026-01-01');
    const note = await discount(f, root, { date: '2026-01-31' });
    await expect(
      service.deferrals.proposeDiscount(f.actor, key(), note.request),
    ).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
    expect(
      (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }))
        .allocated,
    ).toBe('33.33');
    expect(
      await db.orm.select().from(invoiceCredits).where(eq(invoiceCredits.companyId, f.company.id)),
    ).toHaveLength(0);
  });

  test('a later commercial credit preserves the original 19 percent rate after the 2025 rate change', async () => {
    const f = await fixture('normal_vat', 2025),
      root = await deferred(
        f,
        { date: '2025-05-01', rate: '19', tax: '19.00', gross: '119.00' },
        { serviceFrom: '2025-05-01', serviceTo: '2025-07-31' },
      );
    for (const month of ['2025-05-01', '2025-06-01', '2025-07-01']) await release(f, root, month);
    const note = await discount(f, root, {
        date: '2025-08-05',
        rate: '19',
        tax: '3.80',
        gross: '23.80',
      }),
      draft = await service.deferrals.proposeDiscount(f.actor, key(), note.request);
    expect(generalBodySchema.parse(draft.body).lines).toEqual([
      { account: '401', debit: '23.80', credit: '0.00' },
      { account: '609', debit: '0.00', credit: '20.00' },
      { account: '4426', debit: '0.00', credit: '3.80' },
    ]);
    await post(f.actor, draft);
    expect(await balance(f)).toMatchObject({
      '471': '0.00',
      '628': '100.00',
      '609': '-20.00',
      '4426': '15.20',
    });
    const wrong = await discount(f, root, { date: '2025-08-06' });
    await expect(
      service.deferrals.proposeDiscount(f.actor, key(), wrong.request),
    ).rejects.toMatchObject({ code: 'CREDIT_VAT_RATE' });
  });

  test('event ordering and a changed dated VAT registration reject preparation or posting', async () => {
    const f = await fixture(),
      root = await deferred(f),
      note = await discount(f, root),
      draft = await service.deferrals.proposeDiscount(f.actor, key(), note.request);
    await service.books.approve(f.actor, key(), draft.id, approvalReview(draft));
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat_collection',
      value: 'yes',
      effectiveFrom: '2026-02-01',
      evidenceId: note.proof.id,
    });
    await expect(service.ledger.post(f.actor, key(), review(draft))).rejects.toMatchObject({
      code: 'UNSUPPORTED_REGISTRATION_TRANSITION',
    });
    const other = await fixture(),
      r = await deferred(other),
      later = await discount(other, r, { date: '2026-02-10' });
    await post(
      other.actor,
      await service.deferrals.proposeDiscount(other.actor, key(), later.request),
    );
    const earlier = await discount(other, r, { date: '2026-02-09' });
    await expect(
      service.deferrals.proposeDiscount(other.actor, key(), earlier.request),
    ).rejects.toMatchObject({ code: 'DEFERRAL_EVENT_ORDER' });
    await expect(
      cancellation(other, r, '2026-02-01', { net: '66.67', tax: '14.00', gross: '80.67' }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_EVENT_ORDER' });
  });

  test('balanced wrong accounts, source metadata and mixed origins are rejected by service and independent database guards', async () => {
    const f = await fixture(),
      root = await deferred(f),
      note = await discount(f, root),
      draft = await service.deferrals.proposeDiscount(f.actor, key(), note.request),
      base = generalBodySchema.parse(draft.body);
    const mutants = [
      (b: GeneralBody) => {
        b.lines[1].account = '471';
        b.invoice!.account = '471';
      },
      (b: GeneralBody) => {
        b.invoice!.deferralDiscount!.evidenceHash = '0'.repeat(64);
      },
      (b: GeneralBody) => {
        b.invoice!.deferralDiscount!.sourceAmount = '99.00';
      },
      (b: GeneralBody) => {
        b.invoice!.deferral = generalBodySchema.parse(root.proposal.body).invoice!.deferral;
      },
      (b: GeneralBody) => {
        Object.assign(b.invoice!.deferralDiscount!, { servicesUnchanged: false });
      },
      (b: GeneralBody) => {
        b.invoice!.deferralDiscount!.cancellationJournalId = key();
      },
      (b: GeneralBody) => {
        delete b.invoice!.deferralDiscount;
      },
      (b: GeneralBody) => {
        b.invoice!.deductibleTax = '0.00';
        b.lines = [
          { account: '401', debit: '24.20', credit: '0.00' },
          { account: '609', debit: '0.00', credit: '24.20' },
        ];
        b.invoice!.deferralDiscount!.amount = '24.20';
      },
    ];
    for (const mutate of mutants) {
      const body = structuredClone(base);
      mutate(body);
      const forged = await injected(f.actor, body),
        approval = await service.books.approve(f.actor, key(), forged.id, approvalReview(forged));
      await expect(service.ledger.post(f.actor, key(), review(forged))).rejects.toThrow();
      await expect(
        db.write((tx) =>
          postJournal(tx, f.actor, {
            date: body.date,
            kind: 'general',
            sourceId: forged.id,
            approvalId: approval.id,
            evidenceId: body.evidenceId,
            description: body.description,
            lines: body.lines,
          }),
        ),
      ).rejects.toThrow();
    }
    expect(
      await db.orm.select().from(invoiceCredits).where(eq(invoiceCredits.companyId, f.company.id)),
    ).toHaveLength(0);
  });

  test('concurrent retries, large exact amounts, exports and fresh restore retain immutable facts and one credit', async () => {
    const f = await fixture('non_vat'),
      root = await deferred(f, {
        category: 'O',
        net: '90071992547409.95',
        tax: '0.00',
        gross: '90071992547409.95',
      }),
      note = await discount(f, root, {
        category: 'O',
        net: '12345678901234.57',
        tax: '0.00',
        gross: '12345678901234.57',
      }),
      commandKey = key();
    const [a, b] = await Promise.all([
      service.deferrals.proposeDiscount(f.actor, commandKey, note.request),
      service.deferrals.proposeDiscount(f.actor, commandKey, note.request),
    ]);
    expect(a).toEqual(b);
    const postKey = key(),
      posted = await post(f.actor, a, postKey);
    expect(await service.ledger.post(f.actor, postKey, review(a))).toEqual(posted.entry);
    expect((await balance(f))['609']).toBe('-12345678901234.57');
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.invoiceCredits).toHaveLength(1);
    expect(exported.invoiceCredits[0].netBani).toBe('1234567890123457');
    await backup(db, objects, join(directory, 'discount-backup'));
    const restored = await restore(
        join(directory, 'discount-backup'),
        join(directory, 'discount-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.deferrals.proposeDiscount(f.actor, commandKey, note.request)).toEqual(a);
      expect(await copy.ledger.post(f.actor, postKey, review(a))).toEqual(posted.entry);
      expect((await copy.documents.read(f.actor, note.invoice.evidenceId)).bytes).toEqual(
        (await service.documents.read(f.actor, note.invoice.evidenceId)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(invoiceCredits)
          .where(eq(invoiceCredits.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(journals)
          .set({ description: 'Rewritten' })
          .where(eq(journals.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });

  test('official SDK prepares/revises a scoped discount, pauses for exact human approval and honors live revocation', async () => {
    const f = await fixture(),
      root = await deferred(f),
      note = await discount(f, root),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Subscription discount assistant',
        scopes: ['deferrals.proposeDiscount', 'deferrals.reviseDiscount', 'ledger.post'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'discount-contract', version: '1' },
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
      const names = (await client.listTools()).tools.map((row) => row.name);
      expect(names).toContain('deferrals.proposeDiscount');
      expect(names).not.toContain('books.approve');
      const args = { input: note.request, idempotencyKey: key() },
        draft = proposalOutput.parse(
          (await client.callTool({ name: 'deferrals.proposeDiscount', arguments: args }))
            .structuredContent,
        );
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { input: review(draft), idempotencyKey: key() },
          })
        ).isError,
      ).toBe(true);
      const revised = proposalOutput.parse(
        (
          await client.callTool({
            name: 'deferrals.reviseDiscount',
            arguments: {
              input: { ...note.request, id: draft.id, version: draft.version },
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      );
      await service.books.approve(f.actor, key(), revised.id, approvalReview(revised));
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { input: review(revised), idempotencyKey: key() },
          })
        ).isError,
      ).not.toBe(true);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(
        client.callTool({ name: 'deferrals.proposeDiscount', arguments: args }),
      ).rejects.toThrow('Unauthorized');
    } finally {
      await client.close();
    }
  });
});
