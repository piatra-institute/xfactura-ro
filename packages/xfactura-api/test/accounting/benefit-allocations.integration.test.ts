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
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import {
  deferralPositionOutput,
  proposalOutput,
  reviewOutput,
} from '../../source/accounting/capability-contracts';
import {
  canonical,
  generalBodySchema,
  deferralRescheduleEffect,
  type DeferralInput,
  type DeferralRescheduleEffect,
  type DeferralRescheduleInput,
  type GeneralBody,
  type DeferralScopeReductionInput,
} from '../../source/accounting/domain';
import {
  facts,
  proposals,
  journals,
  actionReviews,
  deferralReschedules,
  deferralReleases,
  deferralCancellations,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID(),
  exact = (p: { id: string; version: number; hash: string }) => ({
    id: p.id,
    version: p.version,
    hash: p.hash,
  }),
  secret = 'synthetic-monthly-benefit-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-benefit-allocations-'));
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
        name: 'Calendar day reviewer',
        email: 'monthly-benefits@example.test',
        password: 'synthetic-calendar-password',
      },
    })
  ).user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function source(actor: Actor, text: string, filename = 'contract.txt') {
  return service.documents.record(actor, key(), {
    filename,
    mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
    bytes: Buffer.from(text),
  });
}
async function post(
  actor: Actor,
  p: { id: string; version: number; hash: string },
  commandKey: string = key(),
) {
  const approval = await service.books.approve(actor, key(), p.id, {
      version: p.version,
      hash: p.hash,
    }),
    entry = await service.ledger.post(actor, commandKey, exact(p));
  return { approval, entry };
}
async function fixture(vat: 'normal_vat' | 'non_vat' = 'normal_vat', year = 2026) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Calendar benefit SRL',
      cui: '12345678',
      year,
    }),
    actor = { companyId: company.id, actorId: ownerId },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(
      actor,
      `Original contract: explicit monthly benefit amounts ${company.id}`,
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
async function prepare(f: Fixture, xml: XmlInput = {}, change: Partial<DeferralInput> = {}) {
  const file = await source(
      f.actor,
      invoiceXml({ number: key(), date: `${f.year}-01-01`, ...xml }),
      'service.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id }),
    input: DeferralInput = {
      financialYearId: f.financialYear.id,
      invoiceId: invoice.id,
      recognitionDate: invoice.body.issueDate,
      evidenceId: f.proof.id,
      taxPointBasis: 'early_invoice',
      account: invoice.direction === 'purchase' ? '628' : '704',
      deduction: invoice.direction === 'purchase' && f.vat === 'normal_vat' ? 'full' : 'none',
      counterpartyVatCollection: 'no',
      basis: 'documented_monthly_benefits',
      method: 'evidenced_monthly_amounts',
      benefits: benefitRows(['20.00', '50.00', '30.00']),
      serviceFrom: `${f.year}-01-16`,
      serviceTo: `${f.year}-03-15`,
      evidenceDate: invoice.body.issueDate,
      reason: 'The retained contract establishes uniform benefit on each actual calendar day',
      ...change,
    };
  return {
    proposal: await service.deferrals.proposeInvoice(f.actor, key(), input),
    input,
    invoice,
  };
}
type Root = Awaited<ReturnType<typeof prepare>>;
function benefitRows(amounts: readonly string[], start = 0) {
  return amounts.map((amount, index) => ({
    month: new Date(Date.UTC(2026, start + index, 1)).toISOString().slice(0, 10),
    amount,
    benefit: `Contracted service benefit for month ${start + index + 1}`,
  }));
}
async function confirmation(f: Fixture, date = '2026-01-31') {
  const proof = await source(
    f.actor,
    `Services performed and accepted for ${date}: ${key()}`,
    'acceptance.txt',
  );
  return { evidenceId: proof.id, evidenceDate: date };
}
async function release(f: Fixture, root: Root, month: string, date: string) {
  const benefitEvidence = await confirmation(f, date),
    proposal = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      month,
      benefitEvidence,
    });
  return { proposal, benefitEvidence, ...(await post(f.actor, proposal)) };
}
async function amend(f: Fixture, root: Root) {
  const proof = await source(f.actor, `New agreement changes only future benefit amounts ${key()}`),
    input: DeferralRescheduleInput = {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      date: '2026-02-01',
      effectiveFrom: '2026-02-01',
      serviceTo: '2026-04-10',
      evidenceId: proof.id,
      evidenceDate: '2026-02-01',
      method: 'evidenced_monthly_amounts',
      benefits: benefitRows(['30', '25', '25'], 1),
      priceUnchanged: true,
      reason:
        'Preserve January and document revised future monthly benefits without changing the price',
    },
    review = reviewOutput.parse(
      await service.capabilities.invoke(f.actor, 'deferrals.proposeReschedule', key(), input),
    );
  return { review, input, effect: deferralRescheduleEffect.parse(review.effect), proof };
}
async function apply(f: Fixture, review: { id: string; hash: string }) {
  await service.reviews.approve(f.actor, key(), { id: review.id, hash: review.hash });
  return service.reviews.execute(f.actor, key(), { id: review.id, hash: review.hash });
}
async function statement(
  f: Fixture,
  from: string,
  to: string,
  opening = '1000.00',
  closing = opening,
  rows = '',
) {
  const file = await source(
    f.actor,
    `movement_id,booking_date,amount,currency,reference\n${rows}`,
    'statement.csv',
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: file.id,
    bankAccount: 'RO00BENEFITS',
    statementId: key(),
    from,
    to,
    opening,
    closing,
  });
}
async function proposeScope(f: Fixture, input: unknown) {
  return service.deferrals.proposeScopeReduction(f.actor, key(), input);
}
async function scopeCredit(
  f: Fixture,
  root: Root,
  changes: Partial<DeferralScopeReductionInput> = {},
  xml: XmlInput = {},
) {
  const tax = root.invoice.body.taxes[0],
    nonVat = tax.category === 'O',
    agreement = await source(
      f.actor,
      `Separate signed agreement cancels future services with an explicit remaining monthly plan ${key()}`,
    ),
    file = await source(
      f.actor,
      invoiceXml({
        credit: true,
        direction: root.invoice.direction,
        number: key(),
        originalNumber: root.invoice.body.number,
        date: '2026-02-01',
        category: tax.category,
        rate: tax.rate ?? undefined,
        net: '20.00',
        tax: nonVat ? '0.00' : '4.20',
        gross: nonVat ? '20.00' : '24.20',
        ...xml,
      }),
      'scope-credit.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  const input: DeferralScopeReductionInput = {
    financialYearId: f.financialYear.id,
    invoiceId: invoice.id,
    originalInvoiceId: root.invoice.id,
    recognitionDate: '2026-02-01',
    decisionDate: '2026-02-01',
    treatmentEvidenceId: agreement.id,
    kind: 'cancellation',
    periodBasis: 'current_period_event',
    cancelFrom: '2026-02-01',
    changeBasis: 'cancelled_future_services',
    remainingServices: 'documented_monthly_benefits',
    benefits: benefitRows(['40.00', '20.00'], 1),
    reason:
      'Cancel only unprovided future services and document the exact smaller benefit of each remaining month',
    ...changes,
  };
  return { input, invoice, agreement };
}

async function postInjected(f: Fixture, body: GeneralBody) {
  const factId = key(),
    id = key(),
    hash = sha256(canonical({ kind: 'general', version: 1, body, factId }));
  await db.orm.insert(facts).values({
    id: factId,
    companyId: f.company.id,
    kind: 'general',
    evidenceId: body.evidenceId,
    body,
    createdBy: ownerId,
  });
  await db.orm.insert(proposals).values({
    id,
    companyId: f.company.id,
    factId,
    kind: 'general',
    version: 1,
    hash,
    body,
    sourceKey: key(),
    createdBy: ownerId,
  });
  const approval = await service.books.approve(f.actor, key(), id, { version: 1, hash });
  return db.write((tx) =>
    postJournal(tx, f.actor, {
      date: body.date,
      kind: 'general',
      sourceId: id,
      evidenceId: body.evidenceId,
      description: body.description,
      lines: body.lines,
      approvalId: approval.id,
    }),
  );
}

describe('partial cancellation of documented monthly benefits', () => {
  test.each([
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      deduction: 'full' as const,
      category: 'S',
      amounts: ['20.00', '50.00', '30.00'],
      remaining: ['40.00', '20.00'],
      cancelled: '20.00',
      inputTax: '16.80',
      outputTax: '0.00',
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      deduction: 'none' as const,
      category: 'S',
      amounts: ['24.20', '60.50', '36.30'],
      remaining: ['48.40', '24.20'],
      cancelled: '24.20',
      inputTax: '0.00',
      outputTax: '0.00',
    },
    {
      vat: 'normal_vat' as const,
      direction: 'sale' as const,
      deduction: 'none' as const,
      category: 'S',
      amounts: ['20.00', '50.00', '30.00'],
      remaining: ['40.00', '20.00'],
      cancelled: '20.00',
      inputTax: '0.00',
      outputTax: '16.80',
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      deduction: 'none' as const,
      category: 'S',
      amounts: ['24.20', '60.50', '36.30'],
      remaining: ['48.40', '24.20'],
      cancelled: '24.20',
      inputTax: '0.00',
      outputTax: '0.00',
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      deduction: 'none' as const,
      category: 'O',
      amounts: ['20.00', '50.00', '30.00'],
      remaining: ['40.00', '20.00'],
      cancelled: '20.00',
      inputTax: '0.00',
      outputTax: '0.00',
    },
  ])(
    '$vat $direction $deduction credits only the cancelled value and preserves earned benefits',
    async (c) => {
      const f = await fixture(c.vat),
        root = await prepare(
          f,
          {
            direction: c.direction,
            category: c.category,
            ...(c.category === 'O' ? { tax: '0.00', gross: '100.00' } : {}),
          },
          { deduction: c.deduction, benefits: benefitRows(c.amounts) },
        );
      await post(f.actor, root.proposal);
      await release(f, root, '2026-01-01', '2026-01-31');
      const credit = await scopeCredit(f, root, { benefits: benefitRows(c.remaining, 1) }),
        p = await service.deferrals.proposeScopeReduction(f.actor, key(), credit.input);
      expect(generalBodySchema.parse(p.body).invoice!.deferralCredit).toMatchObject({
        schemaVersion: 3,
        method: 'evidenced_monthly_amounts',
        beforeSchedule: c.amounts.map((amount) => ({ amount })),
        afterSchedule: [c.amounts[0], ...c.remaining].map((amount) => ({ amount })),
      });
      const [a, b] = await Promise.all([post(f.actor, p, p.id), post(f.actor, p, p.id)]);
      expect(a.entry).toEqual(b.entry);
      const state = await service.deferrals.get(f.actor, {
        id: root.proposal.id,
        date: '2026-02-01',
      });
      expect(state).toMatchObject({
        allocated: c.amounts[0],
        cancelled: c.cancelled,
        cancellation: { kind: 'scope_reduction' },
      });
      expect(state.schedule.map((row) => row.amount)).toEqual([c.amounts[0], ...c.remaining]);
      expect(
        (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }))
          .cancelled,
      ).toBe('0.00');
      for (const proof of [credit.agreement.id, credit.invoice.evidenceId])
        await expect(
          service.deferrals.proposeRelease(f.actor, key(), {
            financialYearId: f.financialYear.id,
            deferralId: root.proposal.id,
            month: '2026-02-01',
            benefitEvidence: { evidenceId: proof, evidenceDate: '2026-02-28' },
          }),
        ).rejects.toMatchObject({ code: 'DEFERRAL_BENEFIT_EVIDENCE' });
      await release(f, root, '2026-02-01', '2026-02-28');
      await release(f, root, '2026-03-01', '2026-03-15');
      expect(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
      ).toMatchObject({ status: 'allocated', remaining: '0.00' });
      expect(
        await service.deferrals.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-03-31',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { inputTax: c.inputTax, outputTax: c.outputTax },
      });
    },
  );

  test('explicit reductions reject redistribution, missing months, wrong sums, uniform claims and reused confirmations', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    const january = await release(f, root, '2026-01-01', '2026-01-31'),
      credit = await scopeCredit(f, root);
    for (const changes of [
      { benefits: benefitRows(['10.00', '50.00'], 1) },
      { benefits: benefitRows(['40.00', '19.99'], 1) },
      { benefits: benefitRows(['60.00'], 1) },
      { benefits: benefitRows(['20.00', '40.00'], 1).reverse() },
      { benefits: undefined },
      { remainingServices: 'uniform', benefits: undefined },
      { treatmentEvidenceId: january.benefitEvidence.evidenceId },
    ])
      await expect(proposeScope(f, { ...credit.input, ...changes })).rejects.toThrow();
    const other = await fixture(),
      foreign = await source(other.actor, 'Another company scope agreement');
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), {
        ...credit.input,
        treatmentEvidenceId: foreign.id,
      }),
    ).rejects.toThrow();
    await post(
      f.actor,
      await service.deferrals.proposeScopeReduction(f.actor, key(), credit.input),
    );
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), credit.input),
    ).rejects.toMatchObject({ code: 'DEFERRAL_ALREADY_CANCELLED' });
    await expect(amend(f, root)).rejects.toMatchObject({ code: 'DEFERRAL_BENEFIT_AMOUNT' });
  });

  test('a reduction follows the exact reviewed calendar and supersedes obsolete release approvals', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01', '2026-01-31');
    const credit = await scopeCredit(f, root),
      before = await service.deferrals.proposeScopeReduction(f.actor, key(), credit.input);
    await service.books.approve(f.actor, key(), before.id, {
      version: before.version,
      hash: before.hash,
    });
    const amendment = await amend(f, root);
    await apply(f, amendment.review);
    await expect(service.ledger.post(f.actor, key(), exact(before))).rejects.toThrow();
    const releaseInput = {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-02-01',
        benefitEvidence: await confirmation(f, '2026-02-28'),
      },
      oldRelease = await service.deferrals.proposeRelease(f.actor, key(), releaseInput);
    await service.books.approve(f.actor, key(), oldRelease.id, {
      version: oldRelease.version,
      hash: oldRelease.hash,
    });
    const p = proposalOutput.parse(
      await service.capabilities.invoke(f.actor, 'deferrals.reviseScopeReduction', key(), {
        ...credit.input,
        id: before.id,
        version: before.version,
        benefits: benefitRows(['20.00', '20.00', '20.00'], 1),
      }),
    );
    await expect(service.ledger.post(f.actor, key(), exact(p))).rejects.toThrow();
    await post(f.actor, p);
    await expect(service.ledger.post(f.actor, key(), exact(oldRelease))).rejects.toThrow();
    const queue = await service.capabilities.invoke(f.actor, 'proposals.list', key(), {
      status: 'superseded',
    });
    expect(JSON.stringify(queue)).toContain(oldRelease.id);
    const revised = proposalOutput.parse(
      await service.capabilities.invoke(f.actor, 'deferrals.reviseRelease', key(), {
        ...releaseInput,
        id: oldRelease.id,
        version: oldRelease.version,
      }),
    );
    expect(generalBodySchema.parse(revised.body).deferralRelease).toMatchObject({
      amount: '20.00',
      cancellationJournalId: expect.any(String),
      rescheduleId: amendment.review.id,
    });
    await post(f.actor, revised);
    await release(f, root, '2026-03-01', '2026-03-31');
    await release(f, root, '2026-04-01', '2026-04-10');
    expect(
      (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-04-30' }))
        .remaining,
    ).toBe('0.00');
  });

  test('balanced forged explicit reductions cannot change dates, prefix, months, budgets or monthly limits', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01', '2026-01-31');
    const credit = await scopeCredit(f, root),
      p = await service.deferrals.proposeScopeReduction(f.actor, key(), credit.input),
      mutations: Array<(body: GeneralBody) => void> = [
        (b) => {
          const t = b.invoice!.deferralCredit!;
          if (t.schemaVersion !== 1) t.afterSchedule[1].amount = '39.00';
        },
        (b) => {
          const t = b.invoice!.deferralCredit!;
          if (t.schemaVersion !== 1) {
            t.afterSchedule[1].amount = '10.00';
            t.afterSchedule[2].amount = '50.00';
          }
        },
        (b) => {
          const t = b.invoice!.deferralCredit!;
          if (t.schemaVersion !== 1)
            Object.assign(t.afterSchedule[0], { benefit: 'Forged recognized January services' });
        },
        (b) => {
          const t = b.invoice!.deferralCredit!;
          if (t.schemaVersion !== 1) Object.assign(t.afterSchedule[2], { serviceTo: '2026-03-14' });
        },
        (b) => {
          const t = b.invoice!.deferralCredit!;
          if (t.schemaVersion !== 1) t.afterSchedule.reverse();
        },
        (b) => {
          const t = b.invoice!.deferralCredit!;
          if (t.schemaVersion !== 1) Reflect.deleteProperty(t.afterSchedule[1], 'benefit');
        },
        (b) => {
          Object.assign(b.invoice!.deferralCredit!, {
            schemaVersion: 2,
            remainingServices: 'uniform',
          });
        },
        (b) => {
          b.invoice!.deferralCredit!.evidenceHash = '0'.repeat(64);
        },
      ];
    for (const mutate of mutations) {
      const body = structuredClone(p.body) as GeneralBody;
      mutate(body);
      await expect(postInjected(f, body)).rejects.toThrow();
    }
    await post(f.actor, p);
    const releaseInput = {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-02-01',
        benefitEvidence: await confirmation(f, '2026-02-28'),
      },
      allocation = await service.deferrals.proposeRelease(f.actor, key(), releaseInput);
    for (const mutate of [
      (b: GeneralBody) => {
        Reflect.deleteProperty(b.deferralRelease!, 'cancellationJournalId');
      },
      (b: GeneralBody) => {
        b.deferralRelease!.amount = '50.00';
        b.lines[0].debit = '50.00';
        b.lines[1].credit = '50.00';
      },
      (b: GeneralBody) => {
        b.evidenceId = credit.agreement.id;
        b.deferralRelease!.benefitEvidence!.evidenceId = credit.agreement.id;
        b.deferralRelease!.benefitEvidence!.evidenceHash = credit.agreement.hash;
      },
    ]) {
      const body = structuredClone(allocation.body) as GeneralBody;
      mutate(body);
      await expect(postInjected(f, body)).rejects.toThrow();
    }
    await post(f.actor, allocation);
  });

  test('cancelled zero months stay explicit while remaining positive benefits still block close', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01', '2026-01-31');
    const credit = await scopeCredit(
      f,
      root,
      { benefits: benefitRows(['50.00', '0.00'], 1) },
      { net: '30.00', tax: '6.30', gross: '36.30' },
    );
    await post(
      f.actor,
      await service.deferrals.proposeScopeReduction(f.actor, key(), credit.input),
    );
    const state = await service.deferrals.get(f.actor, {
      id: root.proposal.id,
      date: '2026-03-31',
    });
    expect(state.schedule[2].status).toBe('not_required');
    expect(state.nextDueMonth).toBe('2026-02-01');
    await statement(f, '2026-02-01', '2026-02-28');
    await expect(service.periods.close(f.actor, key(), '2026-02-01')).rejects.toMatchObject({
      code: 'DEFERRAL_ALLOCATION_DUE',
    });
    await release(f, root, '2026-02-01', '2026-02-28');
    await service.periods.close(f.actor, key(), '2026-02-01');
    await expect(release(f, root, '2026-03-01', '2026-03-15')).rejects.toMatchObject({
      code: 'NOTHING_DUE',
    });
    expect(
      (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }))
        .remaining,
    ).toBe('0.00');
  });

  test.each(['purchase', 'sale'] as const)(
    'a paid %s credits only its refund while the remaining benefits stay due',
    async (direction) => {
      const f = await fixture(),
        root = await prepare(f, { direction });
      await post(f.actor, root.proposal);
      const paidBalance = direction === 'purchase' ? '879.00' : '1121.00';
      await statement(
        f,
        '2026-01-01',
        '2026-01-31',
        '1000.00',
        paidBalance,
        `${key()},2026-01-05,${direction === 'purchase' ? '-' : ''}121.00,RON,Invoice payment\n`,
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
      await release(f, root, '2026-01-01', '2026-01-31');
      await service.periods.close(f.actor, key(), '2026-01-01');
      const credit = await scopeCredit(f, root);
      await post(f.actor, await proposeScope(f, credit.input));
      expect(
        await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-02-01' }),
      ).toMatchObject({ balance: '-24.20', status: 'refund_due' });
      const refundedBalance = direction === 'purchase' ? '903.20' : '1096.80';
      await statement(
        f,
        '2026-02-01',
        '2026-02-28',
        paidBalance,
        refundedBalance,
        `${key()},2026-02-10,${direction === 'sale' ? '-' : ''}24.20,RON,Scope refund\n`,
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
      await expect(service.periods.close(f.actor, key(), '2026-02-01')).rejects.toMatchObject({
        code: 'DEFERRAL_ALLOCATION_DUE',
      });
      await release(f, root, '2026-02-01', '2026-02-28');
      await service.periods.close(f.actor, key(), '2026-02-01');
      await release(f, root, '2026-03-01', '2026-03-15');
      expect(
        await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-03-31' }),
      ).toMatchObject({ balance: '0.00', status: 'settled' });
    },
  );

  test('a reduction of the first partial service month preserves its actual start and original zero months', async () => {
    const f = await fixture(),
      root = await prepare(f, {}, { benefits: benefitRows(['20.00', '0.00', '80.00']) });
    await post(f.actor, root.proposal);
    const c = await scopeCredit(
      f,
      root,
      {
        recognitionDate: '2026-01-01',
        decisionDate: '2026-01-01',
        cancelFrom: '2026-01-01',
        benefits: benefitRows(['10.00', '0.00', '70.00']),
      },
      { date: '2026-01-01' },
    );
    await post(f.actor, await proposeScope(f, c.input));
    const state = await service.deferrals.get(f.actor, {
      id: root.proposal.id,
      date: '2026-01-01',
    });
    expect(state.schedule[0]).toMatchObject({
      serviceFrom: '2026-01-16',
      serviceTo: '2026-01-31',
      amount: '10.00',
    });
    expect(state.schedule[1].status).toBe('not_required');
    await release(f, root, '2026-01-01', '2026-01-31');
    await release(f, root, '2026-03-01', '2026-03-15');
    expect(
      (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }))
        .remaining,
    ).toBe('0.00');
  });

  test('exact large reductions and their cached results survive export and fresh restore', async () => {
    const f = await fixture('non_vat'),
      root = await prepare(
        f,
        {
          direction: 'sale',
          category: 'O',
          net: '9007199254740999.95',
          tax: '0.00',
          gross: '9007199254740999.95',
        },
        { benefits: benefitRows(['9007199254740900.01', '60.00', '39.94']) },
      );
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01', '2026-01-31');
    const c = await scopeCredit(f, root, { benefits: benefitRows(['50.00', '29.94'], 1) }),
      prepareKey = key(),
      p = await service.deferrals.proposeScopeReduction(f.actor, prepareKey, c.input),
      postKey = key(),
      posted = await post(f.actor, p, postKey);
    const timing = await source(
        f.actor,
        'Separate agreement changes only the calendar of the large reduced balance',
      ),
      calendar = reviewOutput.parse(
        await service.capabilities.invoke(f.actor, 'deferrals.proposeReschedule', key(), {
          financialYearId: f.financialYear.id,
          deferralId: root.proposal.id,
          date: '2026-02-01',
          effectiveFrom: '2026-02-01',
          serviceTo: '2026-04-10',
          evidenceId: timing.id,
          evidenceDate: '2026-02-01',
          method: 'evidenced_monthly_amounts',
          benefits: benefitRows(['40.00', '20.00', '19.94'], 1),
          priceUnchanged: true,
          reason: 'Preserve the exact large recognized prefix and the posted scope credit',
        }),
      );
    await apply(f, calendar);
    const state = await service.deferrals.get(f.actor, {
      id: root.proposal.id,
      date: '2026-02-01',
    });
    expect(state.schedule.map((row) => row.amount)).toEqual([
      '9007199254740900.01',
      '40.00',
      '20.00',
      '19.94',
    ]);
    expect(state).toMatchObject({
      cancelled: '20.00',
      remaining: '79.94',
      allocated: '9007199254740900.01',
    });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.deferralCancellations[0].amountBani).toBe('2000');
    await backup(db, objects, join(directory, 'scope-backup'));
    const restored = await restore(
        join(directory, 'scope-backup'),
        join(directory, 'scope-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-01' }),
      ).toEqual(state);
      expect(await copy.deferrals.proposeScopeReduction(f.actor, prepareKey, c.input)).toEqual(p);
      expect(await copy.ledger.post(f.actor, postKey, exact(p))).toEqual(posted.entry);
      expect((await copy.documents.read(f.actor, c.agreement.id)).bytes).toEqual(
        (await service.documents.read(f.actor, c.agreement.id)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(deferralCancellations)
          .where(eq(deferralCancellations.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });

  test('MCP prepares and revises an explicit scope credit but cannot approve or replay after revocation', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01', '2026-01-31');
    const c = await scopeCredit(f, root),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Scope assistant',
        scopes: [
          'deferrals.proposeScopeReduction',
          'deferrals.reviseScopeReduction',
          'deferrals.get',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'benefit-scope-contract', version: '1' },
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
    async function invoke(name: string, input: unknown, idempotencyKey = key()) {
      return client.callTool({ name, arguments: { input, idempotencyKey } });
    }
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'books.approve',
      );
      const a = proposalOutput.parse(
        (await invoke('deferrals.proposeScopeReduction', c.input)).structuredContent,
      );
      await service.books.approve(f.actor, key(), a.id, { version: a.version, hash: a.hash });
      const b = proposalOutput.parse(
        (
          await invoke('deferrals.reviseScopeReduction', {
            ...c.input,
            id: a.id,
            version: a.version,
            benefits: benefitRows(['30.00', '30.00'], 1),
          })
        ).structuredContent,
      );
      expect((await invoke('ledger.post', exact(b))).isError).toBe(true);
      await service.books.approve(f.actor, key(), b.id, { version: b.version, hash: b.hash });
      const postKey = key();
      expect((await invoke('ledger.post', exact(b), postKey)).isError).not.toBe(true);
      expect(
        deferralPositionOutput
          .parse(
            (await invoke('deferrals.get', { id: root.proposal.id, date: '2026-02-01' }))
              .structuredContent,
          )
          .schedule.map((row) => row.amount),
      ).toEqual(['20.00', '30.00', '30.00']);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(invoke('ledger.post', exact(b), postKey)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

describe('documented monthly service benefits', () => {
  test.each([
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      deduction: 'full' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      amounts: ['20.00', '50.00', '30.00'],
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      deduction: 'none' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      amounts: ['24.20', '60.50', '36.30'],
    },
    {
      vat: 'normal_vat' as const,
      direction: 'sale' as const,
      deduction: 'none' as const,
      category: 'S',
      tax: '21.00',
      gross: '121.00',
      amounts: ['20.00', '50.00', '30.00'],
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      deduction: 'none' as const,
      category: 'O',
      tax: '0.00',
      gross: '100.00',
      amounts: ['20.00', '50.00', '30.00'],
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      deduction: 'none' as const,
      category: 'O',
      tax: '0.00',
      gross: '100.00',
      amounts: ['20.00', '50.00', '30.00'],
    },
  ])(
    '$vat $direction $deduction retains exact benefits and recognizes VAT once',
    async ({ vat, direction, deduction, category, tax, gross, amounts }) => {
      const f = await fixture(vat),
        root = await prepare(
          f,
          { direction, category, tax, gross },
          { deduction, benefits: benefitRows(amounts) },
        );
      await post(f.actor, root.proposal);
      const body = generalBodySchema.parse(root.proposal.body);
      expect(body.invoice!.deferral).toMatchObject({
        schemaVersion: 3,
        schedule: amounts.map((amount) => ({ amount })),
      });
      const beforeVat = await service.vat.summary(f.actor, {
        financialYearId: f.financialYear.id,
        from: '2026-01-01',
        to: '2026-03-31',
      });
      for (const [index, date] of ['2026-01-31', '2026-02-28', '2026-03-15'].entries()) {
        const allocated = await release(f, root, benefitRows(amounts)[index].month, date);
        expect(
          (await db.orm.select().from(journals).where(eq(journals.id, allocated.entry.id)))[0]
            .evidenceId,
        ).toBe(allocated.benefitEvidence.evidenceId);
        expect(generalBodySchema.parse(allocated.proposal.body).deferralRelease).toMatchObject({
          amount: amounts[index],
          benefitEvidence: allocated.benefitEvidence,
          evidenceHash: f.proof.hash,
        });
      }
      const position = deferralPositionOutput.parse(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
      );
      expect(position.remaining).toBe('0.00');
      expect(position.schedule.map((row) => row.benefit)).toEqual(
        benefitRows(amounts).map((row) => row.benefit),
      );
      const afterVat = await service.vat.summary(f.actor, {
        financialYearId: f.financialYear.id,
        from: '2026-01-01',
        to: '2026-03-31',
      });
      expect(afterVat.totals).toEqual(beforeVat.totals);
      expect(afterVat.entryCount).toBe(beforeVat.entryCount);
      expect(afterVat.status).toBe('reconciled');
    },
  );

  test('service confirmation must be separate, company-scoped and dated within the completed period', async () => {
    const f = await fixture(),
      other = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    const input = {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-01-01',
      },
      good = await confirmation(f);
    for (const benefitEvidence of [
      undefined,
      { evidenceId: f.proof.id, evidenceDate: '2026-01-31' },
      { evidenceId: root.invoice.evidenceId, evidenceDate: '2026-01-31' },
      await confirmation(other),
      { ...good, evidenceDate: '2026-01-30' },
      { ...good, evidenceDate: '2026-02-01' },
    ])
      await expect(
        service.deferrals.proposeRelease(f.actor, key(), {
          ...input,
          ...(benefitEvidence ? { benefitEvidence } : {}),
        }),
      ).rejects.toThrow();
    const a = await service.deferrals.proposeRelease(f.actor, key(), {
      ...input,
      benefitEvidence: good,
    });
    await service.books.approve(f.actor, key(), a.id, { version: a.version, hash: a.hash });
    const replacement = await confirmation(f),
      b = proposalOutput.parse(
        await service.capabilities.invoke(f.actor, 'deferrals.reviseRelease', key(), {
          ...input,
          id: a.id,
          version: a.version,
          benefitEvidence: replacement,
        }),
      );
    await expect(service.ledger.post(f.actor, key(), exact(b))).rejects.toThrow();
    await post(f.actor, b);
    expect((await service.documents.read(f.actor, good.evidenceId)).bytes.length).toBeGreaterThan(
      0,
    );
  });

  test('a reviewed future plan preserves recognized months and invalidates a prepared release', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01', '2026-01-31');
    const old = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      month: '2026-02-01',
      benefitEvidence: await confirmation(f, '2026-02-28'),
    });
    await service.books.approve(f.actor, key(), old.id, { version: old.version, hash: old.hash });
    const amendment = await amend(f, root);
    await expect(
      service.reviews.execute(f.actor, key(), {
        id: amendment.review.id,
        hash: amendment.review.hash,
      }),
    ).rejects.toThrow();
    await apply(f, amendment.review);
    const state = deferralPositionOutput.parse(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-01' }),
    );
    expect(state.schedule.map((row) => row.amount)).toEqual(['20.00', '30.00', '25.00', '25.00']);
    expect(state.schedule[0]).toMatchObject({
      serviceFrom: '2026-01-16',
      benefit: benefitRows(['20.00'])[0].benefit,
    });
    await expect(service.ledger.post(f.actor, key(), exact(old))).rejects.toThrow();
    await expect(
      service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-02-01',
        benefitEvidence: { evidenceId: amendment.proof.id, evidenceDate: '2026-02-28' },
      }),
    ).rejects.toThrow();
    const revised = proposalOutput.parse(
      await service.capabilities.invoke(f.actor, 'deferrals.reviseRelease', key(), {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-02-01',
        id: old.id,
        version: old.version,
        benefitEvidence: await confirmation(f, '2026-02-28'),
      }),
    );
    await post(f.actor, revised);
    await release(f, root, '2026-03-01', '2026-03-31');
    await release(f, root, '2026-04-01', '2026-04-10');
    expect(
      (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-04-30' }))
        .remaining,
    ).toBe('0.00');
  });

  test('zero benefit months have no journal and cannot be released', async () => {
    const f = await fixture(),
      root = await prepare(f, {}, { benefits: benefitRows(['0.00', '100.00', '0.00']) });
    await post(f.actor, root.proposal);
    await expect(release(f, root, '2026-01-01', '2026-01-31')).rejects.toThrow();
    await release(f, root, '2026-02-01', '2026-02-28');
    expect(
      await db.orm
        .select()
        .from(deferralReleases)
        .where(eq(deferralReleases.companyId, f.company.id)),
    ).toHaveLength(1);
  });

  test('balanced malformed monthly plans and service proofs fail independent SQLite posting guards', async () => {
    const f = await fixture(),
      root = await prepare(f);
    const rootMutations: Array<(b: GeneralBody) => void> = [
      (b) => {
        b.invoice!.deferral!.schedule[0].amount = '21.00';
      },
      (b) => {
        b.invoice!.deferral!.schedule.reverse();
      },
      (b) => {
        Reflect.deleteProperty(b.invoice!.deferral!.schedule[0], 'benefit');
      },
      (b) => {
        Object.assign(b.invoice!.deferral!.schedule[0], { serviceTo: '2026-01-30' });
      },
      (b) => {
        b.invoice!.deferral!.schedule[0].amount = '020.00';
      },
      (b) => {
        Object.assign(b.invoice!.deferral!, { method: 'actual_calendar_days' });
      },
    ];
    for (const mutate of rootMutations) {
      const body = structuredClone(root.proposal.body) as GeneralBody;
      mutate(body);
      await expect(postInjected(f, body)).rejects.toThrow();
    }
    await post(f.actor, root.proposal);
    const p = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      month: '2026-01-01',
      benefitEvidence: await confirmation(f),
    });
    const releaseMutations: Array<(b: GeneralBody) => void> = [
      (b) => {
        Reflect.deleteProperty(b.deferralRelease!, 'benefitEvidence');
      },
      (b) => {
        b.deferralRelease!.benefitEvidence!.evidenceHash = '0'.repeat(64);
      },
      (b) => {
        b.deferralRelease!.benefitEvidence!.evidenceDate = '2026-01-30';
      },
      (b) => {
        b.evidenceId = f.proof.id;
        Object.assign(b.deferralRelease!.benefitEvidence!, {
          evidenceId: f.proof.id,
          evidenceHash: f.proof.hash,
        });
      },
    ];
    for (const mutate of releaseMutations) {
      const body = structuredClone(p.body) as GeneralBody;
      mutate(body);
      await expect(postInjected(f, body)).rejects.toThrow();
    }
    await post(f.actor, p);
  });

  test('a forged approved review cannot change its preserved prefix, benefit evidence, month order or budget', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01', '2026-01-31');
    const a = await amend(f, root),
      mutations: Array<(b: DeferralRescheduleEffect) => void> = [
        (b) => {
          b.afterSchedule[1].amount = '31.00';
        },
        (b) => {
          Reflect.deleteProperty(b.afterSchedule[1], 'benefit');
        },
        (b) => {
          Object.assign(b.afterSchedule[1], { serviceTo: '2026-02-27' });
        },
        (b) => {
          Object.assign(b.afterSchedule[0], { benefit: 'Forged original benefit' });
        },
        (b) => {
          b.benefits!.reverse();
        },
        (b) => {
          b.benefits![0].amount = '29.00';
        },
      ];
    for (const mutate of mutations) {
      const effect = structuredClone(a.effect);
      mutate(effect);
      const id = key(),
        input = Object.fromEntries(
          Object.keys(a.input).map((k) => [k, effect[k as keyof DeferralRescheduleEffect]]),
        );
      await db.orm.insert(actionReviews).values({
        id,
        companyId: f.company.id,
        operation: 'deferrals.reschedule',
        input,
        effect,
        hash: sha256(canonical(effect)),
        createdBy: ownerId,
      });
      await db.orm
        .update(actionReviews)
        .set({ approvedBy: ownerId, approvedAt: new Date().toISOString() })
        .where(eq(actionReviews.id, id));
      await expect(
        db.orm
          .insert(deferralReschedules)
          .values({
            id,
            companyId: f.company.id,
            deferralId: root.proposal.id,
            sequence: effect.sequence,
            date: effect.date,
            evidenceId: effect.evidenceId,
            body: effect,
            createdBy: ownerId,
          })
          .execute(),
      ).rejects.toThrow();
    }
    await apply(f, a.review);
  });

  test.each(['cancellation', 'commercial_discount'] as const)(
    '%s retains exact benefits and never invents a uniform scope reduction',
    async (kind) => {
      const f = await fixture(),
        root = await prepare(f);
      await post(f.actor, root.proposal);
      await release(f, root, '2026-01-01', '2026-01-31');
      const agreement = await source(
          f.actor,
          `Separate agreement: ${kind} on future services ${key()}`,
        ),
        file = await source(
          f.actor,
          invoiceXml({
            credit: true,
            number: key(),
            originalNumber: root.invoice.body.number,
            date: '2026-02-01',
            net: '80.00',
            tax: '16.80',
            gross: '96.80',
          }),
          'credit.xml',
        ),
        invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id }),
        input = {
          financialYearId: f.financialYear.id,
          invoiceId: invoice.id,
          originalInvoiceId: root.invoice.id,
          recognitionDate: '2026-02-01',
          decisionDate: '2026-02-01',
          treatmentEvidenceId: agreement.id,
          kind,
          periodBasis: 'current_period_event',
          reason: 'Separate current-period agreement preserves all previously recognized services',
        };
      await expect(
        service.deferrals.proposeScopeReduction(f.actor, key(), {
          ...input,
          kind: 'cancellation',
          cancelFrom: '2026-02-01',
          changeBasis: 'cancelled_future_services',
          remainingServices: 'uniform',
        }),
      ).rejects.toMatchObject({ code: 'DEFERRAL_SCOPE_ALLOCATION' });
      const p =
        kind === 'cancellation'
          ? await service.deferrals.proposeCreditNote(f.actor, key(), {
              ...input,
              cancelFrom: '2026-02-01',
            })
          : await service.deferrals.proposeDiscount(f.actor, key(), {
              ...input,
              servicesUnchanged: true,
            });
      await post(f.actor, p);
      const state = await service.deferrals.get(f.actor, {
        id: root.proposal.id,
        date: '2026-03-31',
      });
      expect(state.allocated).toBe('20.00');
      expect(state.remaining).toBe(kind === 'cancellation' ? '0.00' : '80.00');
      if (kind === 'cancellation')
        await expect(release(f, root, '2026-02-01', '2026-02-28')).rejects.toThrow();
      else {
        await release(f, root, '2026-02-01', '2026-02-28');
        await release(f, root, '2026-03-01', '2026-03-15');
      }
    },
  );

  test('supplemental benefit plans have independent confirmations and cannot alter the parent', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    const second = await prepare(f),
      agreement = await source(
        f.actor,
        `New separately invoiced additional service benefits ${key()}`,
      ),
      proposal = await service.deferrals.proposeSupplement(
        f.actor,
        key(),
        {
          ...second.input,
          parentDeferralId: parent.proposal.id,
          changeBasis: 'additional_future_services',
          evidenceId: agreement.id,
        },
        { id: second.proposal.id, version: second.proposal.version },
      );
    await post(f.actor, proposal);
    await release(f, { ...second, proposal }, '2026-01-01', '2026-01-31');
    expect(
      await service.deferrals.get(f.actor, { id: parent.proposal.id, date: '2026-01-31' }),
    ).toMatchObject({ allocated: '0.00', remaining: '100.00' });
    expect(
      await service.deferrals.get(f.actor, { id: proposal.id, date: '2026-01-31' }),
    ).toMatchObject({
      allocated: '20.00',
      remaining: '80.00',
      supplement: { parentDeferralId: parent.proposal.id },
    });
  });

  test('large exact values, concurrent commands, export and fresh restore preserve the service evidence', async () => {
    const f = await fixture('non_vat'),
      root = await prepare(
        f,
        {
          direction: 'sale',
          category: 'O',
          net: '9007199254740999.95',
          tax: '0.00',
          gross: '9007199254740999.95',
        },
        { benefits: benefitRows(['9007199254740900.01', '0.00', '99.94']) },
      ),
      prepareKey = key(),
      [a, b] = await Promise.all([
        service.deferrals.proposeInvoice(f.actor, prepareKey, root.input),
        service.deferrals.proposeInvoice(f.actor, prepareKey, root.input),
      ]);
    expect(a).toEqual(b);
    await post(f.actor, a);
    const allocated = await release(f, root, '2026-01-01', '2026-01-31'),
      state = await service.deferrals.get(f.actor, { id: a.id, date: '2026-01-31' });
    expect(state.remaining).toBe('99.94');
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.deferralReleases[0].amountBani).toBe('900719925474090001');
    await backup(db, objects, join(directory, 'benefit-backup'));
    const restored = await restore(
        join(directory, 'benefit-backup'),
        join(directory, 'benefit-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.deferrals.get(f.actor, { id: a.id, date: '2026-01-31' })).toEqual(state);
      expect(await copy.deferrals.proposeInvoice(f.actor, prepareKey, root.input)).toEqual(a);
      expect(
        (await copy.documents.read(f.actor, allocated.benefitEvidence.evidenceId)).bytes,
      ).toEqual(
        (await service.documents.read(f.actor, allocated.benefitEvidence.evidenceId)).bytes,
      );
    } finally {
      await copyDb.close();
    }
  });

  test('official MCP prepares and revises benefit plans and service confirmations, requiring current human authority', async () => {
    const f = await fixture(),
      root = await prepare(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Monthly benefit assistant',
        scopes: [
          'deferrals.proposeInvoice',
          'deferrals.reviseInvoice',
          'deferrals.proposeRelease',
          'deferrals.reviseRelease',
          'deferrals.proposeReschedule',
          'deferrals.get',
          'ledger.post',
          'reviews.execute',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'benefit-contract', version: '1' },
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
    async function invoke(name: string, input: unknown, idempotencyKey = key()) {
      return client.callTool({ name, arguments: { input, idempotencyKey } });
    }
    try {
      expect((await client.listTools()).tools.map((row) => row.name)).not.toContain(
        'books.approve',
      );
      const a = proposalOutput.parse(
        (await invoke('deferrals.proposeInvoice', root.input)).structuredContent,
      );
      await service.books.approve(f.actor, key(), a.id, { version: a.version, hash: a.hash });
      const b = proposalOutput.parse(
        (
          await invoke('deferrals.reviseInvoice', {
            ...root.input,
            id: a.id,
            version: a.version,
            benefits: benefitRows(['20', '40', '40']),
          })
        ).structuredContent,
      );
      expect((await invoke('ledger.post', exact(b))).isError).toBe(true);
      await post(f.actor, b);
      const input = {
          financialYearId: f.financialYear.id,
          deferralId: b.id,
          month: '2026-01-01',
          benefitEvidence: await confirmation(f),
        },
        p = proposalOutput.parse(
          (await invoke('deferrals.proposeRelease', input)).structuredContent,
        );
      await service.books.approve(f.actor, key(), p.id, { version: p.version, hash: p.hash });
      const revised = proposalOutput.parse(
        (
          await invoke('deferrals.reviseRelease', {
            ...input,
            id: p.id,
            version: p.version,
            benefitEvidence: await confirmation(f),
          })
        ).structuredContent,
      );
      expect((await invoke('ledger.post', exact(revised))).isError).toBe(true);
      await post(f.actor, revised);
      const amendment = await amend(f, { ...root, proposal: b }),
        review = reviewOutput.parse(
          (await invoke('deferrals.proposeReschedule', amendment.input)).structuredContent,
        );
      expect((await invoke('reviews.execute', { id: review.id, hash: review.hash })).isError).toBe(
        true,
      );
      await service.reviews.approve(f.actor, key(), { id: review.id, hash: review.hash });
      const executeKey = key();
      expect(
        (await invoke('reviews.execute', { id: review.id, hash: review.hash }, executeKey)).isError,
      ).not.toBe(true);
      const position = deferralPositionOutput.parse(
        (await invoke('deferrals.get', { id: b.id, date: '2026-02-01' })).structuredContent,
      );
      expect(position.schedule.map((row) => row.amount)).toEqual([
        '20.00',
        '30.00',
        '25.00',
        '25.00',
      ]);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(
        invoke('reviews.execute', { id: review.id, hash: review.hash }, executeKey),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
