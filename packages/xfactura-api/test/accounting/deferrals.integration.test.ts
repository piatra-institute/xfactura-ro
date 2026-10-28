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
  deferralPositionOutput,
  proposalOutput,
} from '../../source/accounting/capability-contracts';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import {
  generalBodySchema,
  canonical,
  type DeferralInput,
  type DeferralCreditInput,
  type GeneralBody,
  type PostingLine,
} from '../../source/accounting/domain';
import {
  deferralPostings,
  deferralReleases,
  deferralCancellations,
  journalLines,
  proposals,
  facts,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID(),
  review = (proposal: { version: number; hash: string }) => ({
    version: proposal.version,
    hash: proposal.hash,
  }),
  secret = 'synthetic-deferral-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-deferrals-'));
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
      name: 'Subscription reviewer',
      email: 'subscriptions@example.test',
      password: 'synthetic-subscription-password',
    },
  });
  ownerId = user.user.id;
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
  const entry = await service.ledger.post(actor, commandKey, {
    id: proposal.id,
    ...review(proposal),
  });
  expect(
    await service.ledger.post(actor, commandKey, { id: proposal.id, ...review(proposal) }),
  ).toEqual(entry);
  return { approval, entry };
}
async function fixture(vat: 'normal_vat' | 'non_vat' = 'normal_vat', year = 2026) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Subscription fixture SRL',
      cui: '12345678',
      year,
    }),
    actor = { companyId: company.id, actorId: ownerId },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(
      actor,
      'subscription.txt',
      `Uniform subscription contract, separate from invoice ${company.id}`,
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
  return { actor, company, financialYear, proof, vat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function imported(f: Fixture, override: XmlInput = {}) {
  const xml = await source(
    f.actor,
    `${key()}.xml`,
    invoiceXml({ date: '2026-01-01', number: key(), ...override }),
  );
  return service.invoices.import(f.actor, key(), { evidenceId: xml.id });
}
function input(
  f: Fixture,
  invoiceId: string,
  override: Partial<DeferralInput> = {},
): DeferralInput {
  return {
    financialYearId: f.financialYear.id,
    invoiceId,
    recognitionDate: '2026-01-01',
    evidenceId: f.proof.id,
    taxPointBasis: 'early_invoice',
    account: '628',
    deduction: f.vat === 'normal_vat' ? 'full' : 'none',
    counterpartyVatCollection: 'no',
    basis: 'uniform_subscription',
    method: 'equal_calendar_months',
    serviceFrom: '2026-01-01',
    serviceTo: '2026-03-31',
    evidenceDate: '2026-01-01',
    reason: 'Uniform monthly subscription documented by the retained contract',
    ...override,
  };
}
async function deferred(f: Fixture, xml: XmlInput = {}, override: Partial<DeferralInput> = {}) {
  const invoice = await imported(f, xml),
    request = input(f, invoice.id, override),
    proposal = await service.deferrals.proposeInvoice(f.actor, key(), request),
    posted = await post(f.actor, proposal);
  return { invoice, request, proposal, ...posted };
}
async function release(
  f: Fixture,
  deferralId: string,
  month: string,
  financialYearId = f.financialYear.id,
) {
  const proposal = await service.deferrals.proposeRelease(f.actor, key(), {
    financialYearId,
    deferralId,
    month,
  });
  return { proposal, ...(await post(f.actor, proposal)) };
}
async function balances(f: Fixture, financialYearId = f.financialYear.id, to?: string) {
  return Object.fromEntries(
    (await service.ledger.balance(f.actor, { financialYearId, to })).balances.map((row) => [
      row.account,
      row.closing,
    ]),
  );
}
async function statement(
  f: Fixture,
  from: string,
  to: string,
  opening = '1000.00',
  closing = opening,
  rows = '',
) {
  const proof = await source(
    f.actor,
    `${key()}.csv`,
    `movement_id,booking_date,amount,currency,reference\n${rows}`,
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: proof.id,
    bankAccount: 'RO00SUBSCRIPTION',
    statementId: key(),
    from,
    to,
    opening,
    closing,
  });
}

// Deliberately bypass preparation to exercise the independent posting/database boundary.
async function injectedDraft(f: Fixture, body: GeneralBody) {
  return db.write(async (tx) => {
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
    const [draft] = await tx
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
      .returning();
    return draft;
  });
}
async function rejectedAtBothBoundaries(f: Fixture, body: GeneralBody, code: string) {
  const draft = await injectedDraft(f, body),
    approval = await service.books.approve(f.actor, key(), draft.id, review(draft));
  await expect(
    service.ledger.post(f.actor, key(), { id: draft.id, ...review(draft) }),
  ).rejects.toMatchObject({ code });
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
}

async function cancellation(
  f: Fixture,
  root: { invoice: Awaited<ReturnType<typeof imported>> },
  xml: XmlInput = {},
  override: Partial<DeferralCreditInput> = {},
) {
  const proof = await source(
      f.actor,
      `${key()}.txt`,
      'New agreement cancelling the unprovided whole future subscription months',
    ),
    invoice = await imported(f, {
      credit: true,
      direction: root.invoice.direction,
      date: '2026-02-01',
      originalNumber: root.invoice.body.number,
      net: '66.67',
      tax: '14.00',
      gross: '80.67',
      ...xml,
    }),
    request: DeferralCreditInput = {
      financialYearId: f.financialYear.id,
      invoiceId: invoice.id,
      originalInvoiceId: root.invoice.id,
      recognitionDate: '2026-02-01',
      decisionDate: '2026-02-01',
      treatmentEvidenceId: proof.id,
      kind: 'cancellation',
      periodBasis: 'current_period_event',
      reason: 'Written agreement cancels only the unprovided future whole-month services',
      cancelFrom: '2026-02-01',
      ...override,
    };
  return { request, invoice, proof };
}

describe('future subscription cancellation', () => {
  test('a paid purchase retains the closed January expense, cancels future months and refunds the excess payment', async () => {
    const f = await fixture(),
      root = await deferred(f),
      preserved = await service.queries.proposal(f.actor, root.proposal.id);
    await statement(
      f,
      '2026-01-01',
      '2026-01-31',
      '1000.00',
      '879.00',
      'PAY,2026-01-10,-121.00,RON,Subscription\n',
    );
    await post(
      f.actor,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        allocations: [{ invoiceId: root.invoice.id, amount: '121.00' }],
      }),
    );
    await release(f, root.proposal.id, '2026-01-01');
    await service.periods.close(f.actor, key(), '2026-01-01');
    const obsolete = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      month: '2026-02-01',
    });
    const approval = await service.books.approve(f.actor, key(), obsolete.id, review(obsolete));
    const credit = await cancellation(f, root),
      draft = await service.deferrals.proposeCreditNote(f.actor, key(), credit.request);
    expect(generalBodySchema.parse(draft.body).lines).toEqual([
      { account: '401', debit: '80.67', credit: '0.00' },
      { account: '471', debit: '0.00', credit: '66.67' },
      { account: '4426', debit: '0.00', credit: '14.00' },
    ]);
    await post(f.actor, draft);
    expect(
      await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-02-01' }),
    ).toMatchObject({ balance: '-80.67', status: 'refund_due' });
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }),
    ).toMatchObject({
      allocated: '33.33',
      cancelled: '0.00',
      remaining: '66.67',
      cancellation: null,
    });
    const closed = await service.deferrals.get(f.actor, {
      id: root.proposal.id,
      date: '2026-02-28',
    });
    expect(closed).toMatchObject({
      allocated: '33.33',
      cancelled: '66.67',
      remaining: '0.00',
      status: 'cancelled',
      nextDueMonth: null,
    });
    expect(closed.schedule.map((row) => row.status)).toEqual(['posted', 'cancelled', 'cancelled']);
    expect(await service.queries.proposal(f.actor, obsolete.id)).toMatchObject({
      approved: true,
      posted: false,
      superseded: true,
    });
    expect(
      (await service.queries.proposals(f.actor, { status: 'superseded' })).items.map(
        (row) => row.id,
      ),
    ).toContain(obsolete.id);
    expect(
      (await service.queries.proposals(f.actor, { status: 'approved' })).items.map((row) => row.id),
    ).not.toContain(obsolete.id);
    await expect(
      service.ledger.post(f.actor, key(), { id: obsolete.id, ...review(obsolete) }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_MONTH_CANCELLED' });
    const body = generalBodySchema.parse(obsolete.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: obsolete.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      '879.00',
      '959.67',
      'REFUND,2026-02-10,80.67,RON,Unused months\n',
    );
    await post(
      f.actor,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        movementId: (await service.queries.movements(f.actor, { matched: false })).items[0].id,
        allocations: [{ invoiceId: root.invoice.id, amount: '-80.67' }],
      }),
    );
    await service.periods.close(f.actor, key(), '2026-02-01');
    expect(await balances(f)).toMatchObject({
      '471': '0.00',
      '628': '33.33',
      '4426': '7.00',
      '401': '0.00',
      '5121': '959.67',
    });
    expect((await balances(f, f.financialYear.id, '2026-01-31'))['628']).toBe('33.33');
    expect(
      await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-02-28' }),
    ).toMatchObject({ balance: '0.00' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '7.00' } });
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ status: 'reconciled', dueCount: 0 });
    expect((await service.deferrals.list(f.actor, { date: '2026-02-28' })).items).toHaveLength(0);
    expect((await service.deferrals.list(f.actor, { date: '2026-01-31' })).items).toHaveLength(1);
    expect(await service.queries.proposal(f.actor, root.proposal.id)).toEqual(preserved);
  });

  test.each([
    {
      vat: 'normal_vat' as const,
      direction: 'sale' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      deduction: 'none' as const,
      creditTax: '14.00',
      creditGross: '80.67',
      cancelled: '66.67',
      earned: '33.33',
      outstanding: '40.33',
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      category: 'O',
      tax: '0.00',
      gross: '100.00',
      deduction: 'none' as const,
      creditTax: '0.00',
      creditGross: '66.67',
      cancelled: '66.67',
      earned: '33.33',
      outstanding: '33.33',
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'O',
      tax: '0.00',
      gross: '100.00',
      deduction: 'none' as const,
      creditTax: '0.00',
      creditGross: '66.67',
      cancelled: '66.67',
      earned: '33.33',
      outstanding: '33.33',
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      deduction: 'none' as const,
      creditTax: '14.00',
      creditGross: '80.67',
      cancelled: '80.67',
      earned: '40.33',
      outstanding: '40.33',
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      deduction: 'none' as const,
      creditTax: '14.00',
      creditGross: '80.67',
      cancelled: '80.67',
      earned: '40.33',
      outstanding: '40.33',
    },
  ])(
    '$vat $direction $category cancels only the future cost/revenue basis',
    async ({
      vat,
      direction,
      category,
      tax,
      gross,
      deduction,
      creditTax,
      creditGross,
      cancelled,
      earned,
      outstanding,
    }) => {
      const f = await fixture(vat),
        root = await deferred(
          f,
          { direction, category, tax, gross },
          { deduction, account: direction === 'sale' ? '704' : '628' },
        );
      await release(f, root.proposal.id, '2026-01-01');
      const credit = await cancellation(f, root, { category, tax: creditTax, gross: creditGross });
      await post(
        f.actor,
        await service.deferrals.proposeCreditNote(f.actor, key(), credit.request),
      );
      expect(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
      ).toMatchObject({ allocated: earned, cancelled, remaining: '0.00', status: 'cancelled' });
      const result = await balances(f);
      expect(result[direction === 'sale' ? '472' : '471']).toBe('0.00');
      expect(result[direction === 'sale' ? '704' : '628']).toBe(
        direction === 'sale' ? `-${earned}` : earned,
      );
      expect(result['609']).toBeUndefined();
      expect(result['709']).toBeUndefined();
      expect(
        await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-02-01' }),
      ).toMatchObject({ balance: outstanding });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: '0.00',
          outputTax: direction === 'sale' && vat === 'normal_vat' ? '7.00' : '0.00',
        },
      });
    },
  );

  test('full cancellation before services begin clears the invoice and the entire deferred balance', async () => {
    const f = await fixture(),
      root = await deferred(f, {}, { serviceFrom: '2026-02-01' }),
      credit = await cancellation(
        f,
        root,
        { date: '2026-01-15', net: '100.00', tax: '21.00', gross: '121.00' },
        { recognitionDate: '2026-01-15', decisionDate: '2026-01-15' },
      );
    await post(f.actor, await service.deferrals.proposeCreditNote(f.actor, key(), credit.request));
    expect(await balances(f)).toMatchObject({ '401': '0.00', '471': '0.00', '4426': '0.00' });
    expect((await balances(f))['628']).toBeUndefined();
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-15' }),
    ).toMatchObject({ allocated: '0.00', cancelled: '100.00', remaining: '0.00' });
    await statement(f, '2026-01-01', '2026-01-31');
    await service.periods.close(f.actor, key(), '2026-01-01');
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00' } });
  });

  test('a retained cancellation before February is not allowed to erase a recognized month or create a second cancellation', async () => {
    const f = await fixture(),
      root = await deferred(f),
      credit = await cancellation(f, root);
    await release(f, root.proposal.id, '2026-02-01');
    await expect(
      service.deferrals.proposeCreditNote(f.actor, key(), credit.request),
    ).rejects.toMatchObject({ code: 'DEFERRAL_EVENT_ORDER' });
    const later = await cancellation(
      f,
      root,
      { date: '2026-03-01' },
      { recognitionDate: '2026-03-01', decisionDate: '2026-03-01', cancelFrom: '2026-03-01' },
    );
    await expect(
      service.deferrals.proposeCreditNote(f.actor, key(), later.request),
    ).rejects.toMatchObject({ code: 'DEFERRAL_CREDIT_AMOUNT' });
    const correct = await cancellation(
      f,
      root,
      { date: '2026-03-01', net: '33.34', tax: '7.00', gross: '40.34' },
      { recognitionDate: '2026-03-01', decisionDate: '2026-03-01', cancelFrom: '2026-03-01' },
    );
    await post(f.actor, await service.deferrals.proposeCreditNote(f.actor, key(), correct.request));
    await expect(
      service.deferrals.proposeCreditNote(f.actor, key(), correct.request),
    ).rejects.toMatchObject({ code: 'DEFERRAL_ALREADY_CANCELLED' });
  });

  test('new allocations invalidate a cancellation; cancellation invalidates an unaffected prepared release until reviewed again', async () => {
    const f = await fixture(),
      root = await deferred(f),
      credit = await cancellation(
        f,
        root,
        { net: '33.34', tax: '7.00', gross: '40.34' },
        { cancelFrom: '2026-03-01' },
      ),
      draft = await service.deferrals.proposeCreditNote(f.actor, key(), credit.request),
      approval = await service.books.approve(f.actor, key(), draft.id, review(draft));
    await release(f, root.proposal.id, '2026-01-01');
    await expect(
      service.ledger.post(f.actor, key(), { id: draft.id, ...review(draft) }),
    ).rejects.toMatchObject({ code: 'STALE_DEFERRAL_CREDIT' });
    const originalBody = generalBodySchema.parse(draft.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: originalBody.date,
          kind: 'general',
          sourceId: draft.id,
          approvalId: approval.id,
          evidenceId: originalBody.evidenceId,
          description: originalBody.description,
          lines: originalBody.lines,
        }),
      ),
    ).rejects.toThrow();
    const pendingRequest = {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-02-01',
      },
      pending = await service.deferrals.proposeRelease(f.actor, key(), pendingRequest),
      pendingApproval = await service.books.approve(f.actor, key(), pending.id, review(pending));
    const revised = await service.deferrals.proposeCreditNote(f.actor, key(), credit.request, {
      id: draft.id,
      version: draft.version,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: revised.id, ...review(revised) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, revised);
    await expect(
      service.ledger.post(f.actor, key(), { id: pending.id, ...review(pending) }),
    ).rejects.toMatchObject({ code: 'STALE_DEFERRAL_RELEASE' });
    const body = generalBodySchema.parse(pending.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: pending.id,
          approvalId: pendingApproval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const refreshed = await service.deferrals.proposeRelease(f.actor, key(), pendingRequest, {
      id: pending.id,
      version: pending.version,
    });
    await post(f.actor, refreshed);
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
    ).toMatchObject({ allocated: '66.66', cancelled: '33.34', remaining: '0.00' });
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-03-31',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('foreign evidence, unsupported period decisions, retroactive dates, discounts and changed registrations fail closed', async () => {
    const f = await fixture(),
      other = await fixture(),
      root = await deferred(f),
      credit = await cancellation(f, root);
    for (const change of [
      { cancelFrom: '2026-02-02' },
      { cancelFrom: '2026-01-01' },
      { cancelFrom: '2026-04-01' },
      { decisionDate: '2026-02-02' },
      { treatmentEvidenceId: f.proof.id },
      { treatmentEvidenceId: root.invoice.evidenceId },
      { treatmentEvidenceId: credit.invoice.evidenceId },
    ])
      await expect(
        service.deferrals.proposeCreditNote(f.actor, key(), { ...credit.request, ...change }),
      ).rejects.toThrow();
    await expect(
      service.deferrals.proposeCreditNote(f.actor, key(), {
        ...credit.request,
        treatmentEvidenceId: other.proof.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.deferrals.proposeCreditNote(other.actor, key(), credit.request),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() =>
      service.deferrals.proposeCreditNote(f.actor, key(), {
        ...credit.request,
        kind: 'commercial_discount',
      }),
    ).toThrow();
    expect(() =>
      service.deferrals.proposeCreditNote(f.actor, key(), {
        ...credit.request,
        periodBasis: 'prior_year_error',
      }),
    ).toThrow();
    const wrong = await cancellation(f, root, { net: '66.66', tax: '14.00', gross: '80.66' });
    await expect(
      service.deferrals.proposeCreditNote(f.actor, key(), wrong.request),
    ).rejects.toMatchObject({ code: 'DEFERRAL_CREDIT_AMOUNT' });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat_collection',
      value: 'yes',
      effectiveFrom: '2026-02-01',
      evidenceId: credit.proof.id,
    });
    await expect(
      service.deferrals.proposeCreditNote(f.actor, key(), credit.request),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_REGISTRATION_TRANSITION' });
  });

  test('balanced mutations cannot substitute earned expense or the wrong future schedule for a cancellation', async () => {
    const f = await fixture(),
      root = await deferred(f),
      credit = await cancellation(f, root),
      draft = await service.deferrals.proposeCreditNote(f.actor, key(), credit.request);
    const wrongAccount = generalBodySchema.parse(draft.body);
    wrongAccount.lines[1].account = '628';
    await rejectedAtBothBoundaries(f, wrongAccount, 'STALE_DEFERRAL_CREDIT');
    const wrongMonth = generalBodySchema.parse(draft.body);
    wrongMonth.invoice!.deferralCredit!.months[0].month = '2026-01-01';
    await rejectedAtBothBoundaries(f, wrongMonth, 'STALE_DEFERRAL_CREDIT');
  });

  test('large exact cancellations export and restore with immutable projections and replay safety', async () => {
    const f = await fixture('non_vat'),
      root = await deferred(f, {
        category: 'O',
        net: '90071992547409.95',
        tax: '0.00',
        gross: '90071992547409.95',
      });
    await release(f, root.proposal.id, '2026-01-01');
    const credit = await cancellation(f, root, {
        category: 'O',
        net: '60047995031606.64',
        tax: '0.00',
        gross: '60047995031606.64',
      }),
      draft = await service.deferrals.proposeCreditNote(f.actor, key(), credit.request),
      commandKey = key(),
      posted = await post(f.actor, draft, commandKey);
    const expected = await service.deferrals.get(f.actor, {
      id: root.proposal.id,
      date: '2026-03-31',
    });
    expect(expected).toMatchObject({
      allocated: '30023997515803.31',
      cancelled: '60047995031606.64',
      remaining: '0.00',
    });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const data = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(data.deferralCancellations).toHaveLength(1);
    expect(data.deferralCancellations[0].amountBani).toBe('6004799503160664');
    await backup(db, objects, join(directory, 'cancellation-backup'));
    const restored = await restore(
        join(directory, 'cancellation-backup'),
        join(directory, 'cancellation-restore'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
      ).toEqual(expected);
      expect(
        await copy.ledger.post(f.actor, commandKey, { id: draft.id, ...review(draft) }),
      ).toEqual(posted.entry);
      await expect(copyDb.orm.delete(deferralCancellations).execute()).rejects.toThrow();
      await expect(
        copyDb.orm.update(deferralCancellations).set({ amountBani: 1n }).execute(),
      ).rejects.toThrow();
      expect((await copy.documents.read(f.actor, credit.proof.id)).bytes).toEqual(
        Buffer.from('New agreement cancelling the unprovided whole future subscription months'),
      );
      expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
      expect((await copyDb.client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe(
        'ok',
      );
    } finally {
      await copyDb.close();
    }
  });
});

describe('subscription costs and income allocated through 471/472', () => {
  test('balanced but wrongly rounded or nonconsecutive schedules fail at service and database boundaries', async () => {
    const f = await fixture(),
      invoice = await imported(f),
      draft = await service.deferrals.proposeInvoice(f.actor, key(), input(f, invoice.id));
    const wrongRemainder = generalBodySchema.parse(draft.body);
    wrongRemainder.invoice!.deferral!.schedule[0].amount = '33.34';
    wrongRemainder.invoice!.deferral!.schedule[2].amount = '33.33';
    await rejectedAtBothBoundaries(f, wrongRemainder, 'STALE_DEFERRAL');
    const skippedMonth = generalBodySchema.parse(draft.body);
    skippedMonth.invoice!.deferral!.schedule[1].month = '2026-04-01';
    skippedMonth.invoice!.deferral!.schedule[1].date = '2026-04-30';
    await rejectedAtBothBoundaries(f, skippedMonth, 'STALE_DEFERRAL');
    expect((await service.deferrals.list(f.actor, { date: '2026-12-31' })).items).toHaveLength(0);
  });

  test('a balanced release exceeding its approved schedule fails at service and database boundaries', async () => {
    const f = await fixture(),
      root = await deferred(f),
      draft = await service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-01-01',
      }),
      body = generalBodySchema.parse(draft.body);
    body.deferralRelease!.amount = '34.00';
    body.lines = [
      { account: '628', debit: '34.00', credit: '0.00' },
      { account: '471', debit: '0.00', credit: '34.00' },
    ];
    await rejectedAtBothBoundaries(f, body, 'STALE_DEFERRAL_RELEASE');
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }),
    ).toMatchObject({ allocated: '0.00', remaining: '100.00' });
  });

  test('purchase VAT is recognized once, and independent monthly amounts consume 471 without a payment dependency', async () => {
    const f = await fixture(),
      root = await deferred(f),
      original = await service.queries.proposal(f.actor, root.proposal.id);
    expect(generalBodySchema.parse(root.proposal.body).lines).toEqual([
      { account: '471', debit: '100.00', credit: '0.00' },
      { account: '401', debit: '0.00', credit: '121.00' },
      { account: '4426', debit: '21.00', credit: '0.00' },
    ]);
    expect(
      (
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-01' })
      ).schedule.map((row) => row.amount),
    ).toEqual(['33.33', '33.33', '33.34']);
    expect((await balances(f))['628']).toBeUndefined();
    await statement(f, '2026-01-01', '2026-01-31');
    await expect(service.periods.close(f.actor, key(), '2026-01-01')).rejects.toMatchObject({
      code: 'DEFERRAL_ALLOCATION_DUE',
    });
    const january = await release(f, root.proposal.id, '2026-01-01');
    expect(generalBodySchema.parse(january.proposal.body).lines).toEqual([
      { account: '628', debit: '33.33', credit: '0.00' },
      { account: '471', debit: '0.00', credit: '33.33' },
    ]);
    await service.periods.close(f.actor, key(), '2026-01-01');
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-30' }),
    ).toMatchObject({ allocated: '0.00', remaining: '100.00', nextDueMonth: null });
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }),
    ).toMatchObject({ allocated: '33.33', remaining: '66.67', nextDueMonth: null });
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      '1000.00',
      '879.00',
      'PAY,2026-02-10,-121.00,RON,Subscription\n',
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
    await release(f, root.proposal.id, '2026-02-01');
    await service.periods.close(f.actor, key(), '2026-02-01');
    await release(f, root.proposal.id, '2026-03-01');
    await statement(f, '2026-03-01', '2026-03-31', '879.00');
    await service.periods.close(f.actor, key(), '2026-03-01');
    expect(await balances(f)).toMatchObject({
      '471': '0.00',
      '628': '100.00',
      '401': '0.00',
      '4426': '21.00',
      '5121': '879.00',
    });
    expect(
      await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-03-31' }),
    ).toMatchObject({ balance: '0.00' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '21.00' } });
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-03-31',
      }),
    ).toMatchObject({
      status: 'reconciled',
      dueCount: 0,
      prepaid: { ledger: '0.00', remaining: '0.00', difference: '0.00' },
    });
    expect((await service.deferrals.list(f.actor, { date: '2026-03-31' })).items).toHaveLength(0);
    expect(
      (await service.deferrals.list(f.actor, { date: '2026-03-31', onlyOpen: false })).items,
    ).toHaveLength(1);
    expect(await service.queries.proposal(f.actor, root.proposal.id)).toEqual(original);
  });

  test.each([
    {
      vat: 'normal_vat' as const,
      direction: 'sale' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      amount: '100.00',
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      category: 'O',
      tax: '0.00',
      gross: '100.00',
      amount: '100.00',
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'O',
      tax: '0.00',
      gross: '100.00',
      amount: '100.00',
      deduction: 'none' as const,
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      amount: '121.00',
      deduction: 'none' as const,
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      amount: '121.00',
      deduction: 'none' as const,
    },
  ])(
    '$vat $direction $category: monthly releases retain the correct cost/income basis without another VAT posting',
    async ({ vat, direction, category, tax, gross, amount, deduction }) => {
      const f = await fixture(vat),
        root = await deferred(
          f,
          { direction, category, tax, gross },
          { account: direction === 'sale' ? '704' : '628', deduction },
        );
      expect(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-01' }),
      ).toMatchObject({
        amount,
        remaining: amount,
        controlAccount: direction === 'sale' ? '472' : '471',
      });
      for (const month of ['2026-01-01', '2026-02-01', '2026-03-01'])
        await release(f, root.proposal.id, month);
      const result = await balances(f);
      if (direction === 'sale') {
        expect(result).toMatchObject({ '4111': gross, '472': '0.00', '704': `-${amount}` });
        if (tax === '0.00') expect(result['4427']).toBeUndefined();
        else expect(result['4427']).toBe(`-${tax}`);
      } else {
        expect(result).toMatchObject({ '401': `-${gross}`, '471': '0.00', '628': amount });
        expect(result['4426']).toBeUndefined();
      }
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: '0.00', outputTax: direction === 'sale' ? tax : '0.00' },
      });
    },
  );

  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    'December $direction invoice carries into a separately opened year with no new VAT',
    async ({ direction }) => {
      const f = await fixture('normal_vat', 2025),
        root = await deferred(
          f,
          { date: '2025-12-10', direction },
          {
            recognitionDate: '2025-12-10',
            evidenceDate: '2025-12-01',
            serviceFrom: '2026-01-01',
            account: direction === 'sale' ? '704' : '628',
            deduction: direction === 'sale' ? 'none' : 'full',
          },
        );
      await statement(f, '2025-12-01', '2025-12-31');
      await service.periods.close(f.actor, key(), '2025-12-01');
      const year = await service.foundation.createYear(f.actor, key(), {
        kind: 'financial',
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      });
      const lines: PostingLine[] =
        direction === 'purchase'
          ? [
              { account: '5121', debit: '1000.00', credit: '0.00' },
              { account: '471', debit: '100.00', credit: '0.00' },
              { account: '4426', debit: '21.00', credit: '0.00' },
              { account: '401', debit: '0.00', credit: '121.00' },
              { account: '1012', debit: '0.00', credit: '1000.00' },
            ]
          : [
              { account: '5121', debit: '1000.00', credit: '0.00' },
              { account: '4111', debit: '121.00', credit: '0.00' },
              { account: '472', debit: '0.00', credit: '100.00' },
              { account: '4427', debit: '0.00', credit: '21.00' },
              { account: '1012', debit: '0.00', credit: '1000.00' },
            ];
      await post(
        f.actor,
        await service.ledger.propose(f.actor, key(), {
          financialYearId: year.id,
          evidenceId: f.proof.id,
          date: year.from,
          purpose: 'opening',
          description: 'Explicit carried opening position',
          sourceReference: 'opening2026',
          lines,
        }),
      );
      const monthly = await release(f, root.proposal.id, '2026-01-01', year.id);
      expect(generalBodySchema.parse(monthly.proposal.body).deferralRelease).toMatchObject({
        sourceFinancialYearId: f.financialYear.id,
        sourceJournalId: root.entry.id,
      });
      await statement(f, '2026-01-01', '2026-01-31');
      await service.periods.close(f.actor, key(), '2026-01-01');
      expect(
        await service.deferrals.reconcile(f.actor, {
          financialYearId: year.id,
          date: '2026-01-31',
        }),
      ).toMatchObject({
        status: 'reconciled',
        [direction === 'purchase' ? 'prepaid' : 'deferredRevenue']: {
          ledger: '66.67',
          remaining: '66.67',
          difference: '0.00',
        },
      });
      expect(
        (await balances(f, f.financialYear.id))[direction === 'purchase' ? '628' : '704'],
      ).toBeUndefined();
      expect(await service.vat.summary(f.actor, { financialYearId: year.id })).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: '0.00', outputTax: '0.00' },
      });
      const credit = await cancellation(f, root, {}, { financialYearId: year.id });
      await post(
        f.actor,
        await service.deferrals.proposeCreditNote(f.actor, key(), credit.request),
      );
      expect(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-28' }),
      ).toMatchObject({ allocated: '33.33', cancelled: '66.67', remaining: '0.00' });
      expect(
        await service.deferrals.reconcile(f.actor, {
          financialYearId: year.id,
          date: '2026-02-28',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(await service.vat.summary(f.actor, { financialYearId: year.id })).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: direction === 'purchase' ? '-14.00' : '0.00',
          outputTax: direction === 'sale' ? '-14.00' : '0.00',
        },
      });
    },
  );

  test('missing carried 471 is visible and blocks close even after the allocation and bank reconcile', async () => {
    const f = await fixture('normal_vat', 2025),
      root = await deferred(
        f,
        { date: '2025-12-10' },
        { recognitionDate: '2025-12-10', evidenceDate: '2025-12-01', serviceFrom: '2026-01-01' },
      ),
      year = await service.foundation.createYear(f.actor, key(), {
        kind: 'financial',
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      });
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: year.id,
        evidenceId: f.proof.id,
        date: year.from,
        purpose: 'opening',
        description: 'Incomplete carried opening fixture',
        sourceReference: 'opening2026',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
        ],
      }),
    );
    await release(f, root.proposal.id, '2026-01-01', year.id);
    await statement(f, '2026-01-01', '2026-01-31');
    expect(
      await service.deferrals.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-31' }),
    ).toMatchObject({
      status: 'needs_review',
      prepaid: { ledger: '-33.33', remaining: '66.67', difference: '-100.00' },
    });
    await expect(service.periods.close(f.actor, key(), '2026-01-01')).rejects.toMatchObject({
      code: 'DEFERRAL_CONTROL_DIFFERENCE',
    });
  });

  test('zero-bani months need no journal, while the last month allocates the exact residual', async () => {
    const f = await fixture('non_vat'),
      root = await deferred(f, { category: 'O', net: '0.01', tax: '0.00', gross: '0.01' });
    expect(
      (
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' })
      ).schedule.map((row) => [row.amount, row.status]),
    ).toEqual([
      ['0.00', 'not_required'],
      ['0.00', 'not_required'],
      ['0.01', 'scheduled'],
    ]);
    await expect(
      service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'NOTHING_DUE' });
    await statement(f, '2026-01-01', '2026-01-31');
    await service.periods.close(f.actor, key(), '2026-01-01');
    await release(f, root.proposal.id, '2026-03-01');
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
    ).toMatchObject({ allocated: '0.01', remaining: '0.00', status: 'allocated' });
  });

  test('competing releases require exact approval, allocate once and are guarded directly in SQLite', async () => {
    const f = await fixture(),
      root = await deferred(f),
      request = {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-01-01',
      };
    const drafts = await Promise.all([
      service.deferrals.proposeRelease(f.actor, key(), request),
      service.deferrals.proposeRelease(f.actor, key(), request),
    ]);
    expect(drafts[0].id).toBe(drafts[1].id);
    const approvals = await Promise.all(
      drafts.map((draft) => service.books.approve(f.actor, key(), draft.id, review(draft))),
    );
    const exact = { id: drafts[0].id, ...review(drafts[0]) },
      commandKey = key(),
      entry = await service.ledger.post(f.actor, commandKey, exact);
    expect(await service.ledger.post(f.actor, commandKey, exact)).toEqual(entry);
    expect(
      await service.ledger.post(f.actor, key(), { id: drafts[1].id, ...review(drafts[1]) }),
    ).toEqual(entry);
    await expect(service.deferrals.proposeRelease(f.actor, key(), request)).rejects.toMatchObject({
      code: 'DEFERRAL_ALREADY_ALLOCATED',
    });
    const body = generalBodySchema.parse(drafts[1].body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: drafts[1].id,
          approvalId: approvals[1].id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    expect(
      (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }))
        .allocated,
    ).toBe('33.33');
    await expect(
      db.orm.delete(deferralReleases).where(eq(deferralReleases.companyId, f.company.id)).execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(deferralReleases)
        .set({ amountBani: 1n })
        .where(eq(deferralReleases.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm.delete(deferralPostings).where(eq(deferralPostings.companyId, f.company.id)).execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(deferralPostings)
        .set({ invoiceId: key() })
        .where(eq(deferralPostings.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
  });

  test('revising the schedule invalidates the prior approval and monthly release revision requires new approval', async () => {
    const f = await fixture(),
      invoice = await imported(f),
      request = input(f, invoice.id),
      draft = await service.deferrals.proposeInvoice(f.actor, key(), request);
    await service.books.approve(f.actor, key(), draft.id, review(draft));
    const revised = await service.deferrals.proposeInvoice(
      f.actor,
      key(),
      { ...request, serviceTo: '2026-02-28' },
      { id: draft.id, version: draft.version },
    );
    await expect(
      service.ledger.post(f.actor, key(), { id: draft.id, ...review(draft) }),
    ).rejects.toThrow();
    await expect(
      service.ledger.post(f.actor, key(), { id: revised.id, ...review(revised) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, revised);
    const releaseRequest = {
        financialYearId: f.financialYear.id,
        deferralId: revised.id,
        month: '2026-01-01',
      },
      first = await service.deferrals.proposeRelease(f.actor, key(), releaseRequest);
    await service.books.approve(f.actor, key(), first.id, review(first));
    const second = await service.deferrals.proposeRelease(f.actor, key(), releaseRequest, {
      id: first.id,
      version: first.version,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: second.id, ...review(second) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, second);
    expect(
      await service.deferrals.get(f.actor, { id: revised.id, date: '2026-01-31' }),
    ).toMatchObject({ amount: '100.00', allocated: '50.00', remaining: '50.00' });
  });

  test('partial periods, unproven terms, foreign evidence, wrong years and out-of-plan releases fail closed', async () => {
    const f = await fixture(),
      other = await fixture(),
      invoice = await imported(f),
      request = input(f, invoice.id);
    for (const change of [
      { serviceFrom: '2026-01-02' },
      { serviceTo: '2026-03-30' },
      { evidenceDate: '2026-01-02' },
      { evidenceId: invoice.evidenceId },
      { account: '4092' },
      { recognitionDate: '2026-01-02' },
      { serviceFrom: '2025-12-01' },
    ])
      await expect(
        service.deferrals.proposeInvoice(f.actor, key(), { ...request, ...change }),
      ).rejects.toThrow();
    expect(() =>
      service.deferrals.proposeInvoice(f.actor, key(), { ...request, basis: 'advance' }),
    ).toThrow();
    await expect(
      service.deferrals.proposeInvoice(f.actor, key(), { ...request, evidenceId: other.proof.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.deferrals.proposeInvoice(other.actor, key(), request),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const root = await service.deferrals.proposeInvoice(f.actor, key(), request);
    await post(f.actor, root);
    await expect(
      service.deferrals.get(other.actor, { id: root.id, date: '2026-01-31' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.deferrals.get(f.actor, { id: root.id, date: '2025-12-31' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const change of [
      { month: '2026-01-02' },
      { month: '2026-04-01' },
      { financialYearId: other.financialYear.id },
    ])
      await expect(
        service.deferrals.proposeRelease(f.actor, key(), {
          financialYearId: f.financialYear.id,
          deferralId: root.id,
          month: '2026-01-01',
          ...change,
        }),
      ).rejects.toThrow();
    expect((await service.deferrals.list(other.actor, { date: '2026-01-31' })).items).toHaveLength(
      0,
    );
  });

  test('known VAT rate boundaries and registration changes require a distinct treatment', async () => {
    const f = await fixture('normal_vat', 2025),
      invoice = await imported(f, {
        date: '2025-07-01',
        rate: '19',
        tax: '19.00',
        gross: '119.00',
      });
    await expect(
      service.deferrals.proposeInvoice(
        f.actor,
        key(),
        input(f, invoice.id, {
          recognitionDate: '2025-07-01',
          evidenceDate: '2025-07-01',
          serviceFrom: '2025-07-01',
          serviceTo: '2025-09-30',
        }),
      ),
    ).rejects.toMatchObject({ code: 'DEFERRAL_VAT_TRANSITION' });
    const current = await fixture(),
      root = await deferred(current),
      pending = await service.deferrals.proposeRelease(current.actor, key(), {
        financialYearId: current.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-02-01',
      });
    await service.books.approve(current.actor, key(), pending.id, review(pending));
    await service.foundation.recordRegime(current.actor, key(), {
      axis: 'vat_collection',
      value: 'yes',
      effectiveFrom: '2026-02-01',
      evidenceId: current.proof.id,
    });
    await expect(
      service.ledger.post(current.actor, key(), { id: pending.id, ...review(pending) }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_VAT_TRANSITION' });
    await release(current, root.proposal.id, '2026-01-01');
    const another = await imported(current);
    await expect(
      service.deferrals.proposeInvoice(current.actor, key(), input(current, another.id)),
    ).rejects.toMatchObject({ code: 'DEFERRAL_VAT_TRANSITION' });
  });

  test('a deferred invoice cannot enter the ordinary credit-note workflow', async () => {
    const f = await fixture(),
      root = await deferred(f, { number: 'SUB-ORIGINAL' }),
      credit = await imported(f, {
        credit: true,
        number: key(),
        originalNumber: 'SUB-ORIGINAL',
        date: '2026-02-10',
      });
    await expect(
      service.invoices.proposeCreditNote(f.actor, key(), {
        financialYearId: f.financialYear.id,
        invoiceId: credit.id,
        originalInvoiceId: root.invoice.id,
        recognitionDate: '2026-02-10',
        decisionDate: '2026-02-10',
        treatmentEvidenceId: f.proof.id,
        kind: 'cancellation',
        periodBasis: 'current_period_event',
        reason: 'Negotiated subscription cancellation requiring its own allocation correction',
      }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_CREDIT_TREATMENT' });
  });

  test('dated bounded pages expose due amounts and retain large exact allocations in exports and a fresh restore', async () => {
    const f = await fixture('non_vat'),
      total = 9007199254740995n,
      decimal = (n: bigint) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`,
      root = await deferred(f, {
        category: 'O',
        net: decimal(total),
        tax: '0.00',
        gross: decimal(total),
      });
    expect(
      (
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' })
      ).schedule.map((row) => row.amount),
    ).toEqual(['30023997515803.31', '30023997515803.31', '30023997515803.33']);
    const monthly = await service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-01-01',
      }),
      commandKey = key(),
      posted = await post(f.actor, monthly, commandKey);
    const second = await deferred(f, { category: 'O', tax: '0.00', gross: '100.00' });
    const firstPage = await service.deferrals.list(f.actor, { date: '2026-01-31', limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await service.deferrals.list(f.actor, {
      date: '2026-01-31',
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(new Set([...firstPage.items, ...secondPage.items].map((row) => row.id))).toEqual(
      new Set([root.proposal.id, second.proposal.id]),
    );
    expect(secondPage.nextCursor).toBeNull();
    const expected = await service.deferrals.get(f.actor, {
      id: root.proposal.id,
      date: '2026-01-31',
    });
    expect(expected).toMatchObject({
      allocated: '30023997515803.31',
      remaining: '60047995031606.64',
    });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const data = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(data.deferralPostings).toHaveLength(2);
    expect(data.deferralReleases).toHaveLength(1);
    expect(data.deferralReleases[0].amountBani).toBe('3002399751580331');
    await backup(db, objects, join(directory, 'subscription-backup'));
    const restored = await restore(
        join(directory, 'subscription-backup'),
        join(directory, 'subscription-restore'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }),
      ).toEqual(expected);
      expect(
        await copy.ledger.post(f.actor, commandKey, { id: monthly.id, ...review(monthly) }),
      ).toEqual(posted.entry);
      expect(
        await copyDb.orm
          .select()
          .from(journalLines)
          .where(eq(journalLines.companyId, f.company.id)),
      ).toEqual(
        await db.orm.select().from(journalLines).where(eq(journalLines.companyId, f.company.id)),
      );
      expect((await copy.documents.read(f.actor, f.proof.id)).bytes).toEqual(
        Buffer.from(`Uniform subscription contract, separate from invoice ${f.company.id}`),
      );
      await expect(copyDb.orm.delete(deferralReleases).execute()).rejects.toThrow();
      expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
      expect((await copyDb.client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe(
        'ok',
      );
    } finally {
      await copyDb.close();
    }
  });

  test('scoped MCP prepares schedules and monthly releases, pauses for exact human approval, and respects revocation', async () => {
    const f = await fixture(),
      invoice = await imported(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Subscription assistant',
        scopes: [
          'deferrals.proposeInvoice',
          'deferrals.proposeCreditNote',
          'deferrals.reviseCreditNote',
          'deferrals.reviseInvoice',
          'deferrals.proposeRelease',
          'deferrals.reviseRelease',
          'deferrals.get',
          'deferrals.list',
          'deferrals.reconcile',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    const publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'subscription-contract', version: '1' },
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
      expect(names).toContain('deferrals.proposeInvoice');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('ledger.propose');
      const draft = proposalOutput.parse(
        (
          await client.callTool({
            name: 'deferrals.proposeInvoice',
            arguments: { input: input(f, invoice.id), idempotencyKey: key() },
          })
        ).structuredContent,
      );
      const exact = { input: { id: draft.id, ...review(draft) }, idempotencyKey: key() };
      expect(
        JSON.stringify(await client.callTool({ name: 'ledger.post', arguments: exact })),
      ).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), draft.id, review(draft));
      expect((await client.callTool({ name: 'ledger.post', arguments: exact })).isError).not.toBe(
        true,
      );
      const monthly = proposalOutput.parse(
        (
          await client.callTool({
            name: 'deferrals.proposeRelease',
            arguments: {
              input: {
                financialYearId: f.financialYear.id,
                deferralId: draft.id,
                month: '2026-01-01',
              },
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      );
      const releaseExact = { input: { id: monthly.id, ...review(monthly) }, idempotencyKey: key() };
      expect(
        JSON.stringify(await client.callTool({ name: 'ledger.post', arguments: releaseExact })),
      ).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), monthly.id, review(monthly));
      const result = await client.callTool({ name: 'ledger.post', arguments: releaseExact });
      expect(result.isError).not.toBe(true);
      expect(
        (await client.callTool({ name: 'ledger.post', arguments: releaseExact })).structuredContent,
      ).toEqual(result.structuredContent);
      expect(
        deferralPositionOutput.parse(
          (
            await client.callTool({
              name: 'deferrals.get',
              arguments: { input: { id: draft.id, date: '2026-01-31' } },
            })
          ).structuredContent,
        ),
      ).toMatchObject({ remaining: '66.67' });
      expect(
        (
          await client.callTool({
            name: 'deferrals.reconcile',
            arguments: { input: { financialYearId: f.financialYear.id, date: '2026-01-31' } },
          })
        ).isError,
      ).not.toBe(true);
      const cancelled = await cancellation(f, { invoice }),
        cancellationDraft = proposalOutput.parse(
          (
            await client.callTool({
              name: 'deferrals.proposeCreditNote',
              arguments: { input: cancelled.request, idempotencyKey: key() },
            })
          ).structuredContent,
        );
      await service.books.approve(f.actor, key(), cancellationDraft.id, review(cancellationDraft));
      const revisedCancellation = proposalOutput.parse(
          (
            await client.callTool({
              name: 'deferrals.reviseCreditNote',
              arguments: {
                input: {
                  ...cancelled.request,
                  reason:
                    'Written cancellation reviewed again with the retained future-month agreement',
                  id: cancellationDraft.id,
                  version: cancellationDraft.version,
                },
                idempotencyKey: key(),
              },
            })
          ).structuredContent,
        ),
        cancellationExact = {
          input: { id: revisedCancellation.id, ...review(revisedCancellation) },
          idempotencyKey: key(),
        };
      expect(
        JSON.stringify(
          await client.callTool({ name: 'ledger.post', arguments: cancellationExact }),
        ),
      ).toContain('APPROVAL_REQUIRED');
      await service.books.approve(
        f.actor,
        key(),
        revisedCancellation.id,
        review(revisedCancellation),
      );
      expect(
        (await client.callTool({ name: 'ledger.post', arguments: cancellationExact })).isError,
      ).not.toBe(true);
      expect(
        deferralPositionOutput.parse(
          (
            await client.callTool({
              name: 'deferrals.get',
              arguments: { input: { id: draft.id, date: '2026-02-28' } },
            })
          ).structuredContent,
        ),
      ).toMatchObject({ cancelled: '66.67', remaining: '0.00' });
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(
        client.callTool({ name: 'ledger.post', arguments: releaseExact }),
      ).rejects.toThrow('Unauthorized');
    } finally {
      await client.close();
    }
  });
});
