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
import { reviewOutput } from '../../source/accounting/capability-contracts';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import {
  canonical,
  deferralRescheduleEffect,
  generalBodySchema,
  type DeferralInput,
  type DeferralRescheduleInput,
  type DeferralRescheduleEffect,
  type GeneralBody,
} from '../../source/accounting/domain';
import {
  actionReviews,
  deferralReschedules,
  deferralReleases,
  facts,
  proposals,
  journals,
  journalLines,
  memberships,
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
  secret = 'synthetic-reschedule-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-reschedules-'));
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
        name: 'Schedule reviewer',
        email: 'reschedules@example.test',
        password: 'synthetic-reschedule-password',
      },
    })
  ).user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function source(actor: Actor, text: string, filename = 'agreement.txt') {
  return service.documents.record(actor, key(), {
    filename,
    mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
    bytes: Buffer.from(text),
  });
}
async function post(actor: Actor, p: { id: string; version: number; hash: string }) {
  await service.books.approve(actor, key(), p.id, { version: p.version, hash: p.hash });
  return service.ledger.post(actor, key(), exact(p));
}
async function fixture(
  vat: 'normal_vat' | 'non_vat' = 'normal_vat',
  xml: XmlInput = {},
  change: Partial<DeferralInput> = {},
  year = 2026,
) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Schedule fixture SRL',
      cui: '12345678',
      year,
    }),
    actor = { actorId: ownerId, companyId: company.id },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(
      actor,
      `Original uniform subscription agreement and registration proof ${company.id}`,
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
  const file = await source(
      actor,
      invoiceXml({ number: 'SUBSCRIPTION', date: `${year}-01-01`, ...xml }),
      'subscription.xml',
    ),
    invoice = await service.invoices.import(actor, key(), { evidenceId: file.id });
  const root = await service.deferrals.proposeInvoice(actor, key(), {
    financialYearId: financialYear.id,
    invoiceId: invoice.id,
    recognitionDate: invoice.body.issueDate,
    evidenceId: proof.id,
    taxPointBasis: 'early_invoice',
    account: invoice.direction === 'purchase' ? '628' : '704',
    deduction: vat === 'normal_vat' && invoice.direction === 'purchase' ? 'full' : 'none',
    counterpartyVatCollection: 'no',
    basis: 'uniform_subscription',
    method: 'equal_calendar_months',
    serviceFrom: `${year}-01-01`,
    serviceTo: `${year}-03-31`,
    evidenceDate: invoice.body.issueDate,
    reason: 'Independently evidenced uniform monthly subscription',
    ...change,
  });
  const entry = await post(actor, root);
  return { company, actor, financialYear, proof, invoice, root, entry };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function release(f: Fixture, month: string, year = f.financialYear.id) {
  const p = await service.deferrals.proposeRelease(f.actor, key(), {
    financialYearId: year,
    deferralId: f.root.id,
    month,
  });
  return { proposal: p, entry: await post(f.actor, p) };
}
async function request(f: Fixture, change: Partial<DeferralRescheduleInput> = {}) {
  const proof = await source(
      f.actor,
      `Signed prospective calendar change; price unchanged ${key()}`,
    ),
    input: DeferralRescheduleInput = {
      financialYearId: f.financialYear.id,
      deferralId: f.root.id,
      date: '2026-02-01',
      effectiveFrom: '2026-02-01',
      serviceTo: '2026-04-30',
      evidenceId: proof.id,
      evidenceDate: '2026-02-01',
      method: 'equal_calendar_months',
      priceUnchanged: true,
      reason: 'New agreement changes only future full-month service benefits',
      ...change,
    };
  const review = reviewOutput.parse(
    await service.capabilities.invoke(f.actor, 'deferrals.proposeReschedule', key(), input),
  );
  return { review, input, proof, effect: deferralRescheduleEffect.parse(review.effect) };
}
async function apply(f: Fixture, r: { id: string; hash: string }) {
  await service.reviews.approve(f.actor, key(), r);
  return service.reviews.execute(f.actor, key(), r);
}
async function books(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const [name, table] of Object.entries({ journals, journalLines, deferralReleases }))
    result[name] = await db.orm.select().from(table).where(eq(table.companyId, f.company.id));
  return result;
}
async function balance(f: Fixture, year = f.financialYear.id) {
  return Object.fromEntries(
    (await service.ledger.balance(f.actor, { financialYearId: year })).balances.map((row) => [
      row.account,
      row.closing,
    ]),
  );
}
async function statement(f: Fixture, from: string, to: string) {
  const file = await source(
    f.actor,
    'movement_id,booking_date,amount,currency,reference\n',
    'statement.csv',
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: file.id,
    bankAccount: 'RO00SUBSCRIPTION',
    statementId: key(),
    from,
    to,
    opening: '1000.00',
    closing: '1000.00',
  });
}
async function credit(
  f: Fixture,
  kind: 'commercial_discount' | 'cancellation',
  net = '10.00',
  tax = '2.10',
  gross = '12.10',
  date = '2026-02-01',
) {
  const proof = await source(f.actor, `Separate price or cancellation agreement ${key()}`),
    file = await source(
      f.actor,
      invoiceXml({
        direction: f.invoice.direction,
        credit: true,
        number: key(),
        originalNumber: f.invoice.body.number,
        date,
        net,
        tax,
        gross,
      }),
      'credit.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  const input = {
    financialYearId: f.financialYear.id,
    invoiceId: invoice.id,
    originalInvoiceId: f.invoice.id,
    recognitionDate: date,
    decisionDate: date,
    treatmentEvidenceId: proof.id,
    kind,
    periodBasis: 'current_period_event' as const,
    reason: 'Separately agreed change documented after the original contract',
  };
  return kind === 'commercial_discount'
    ? service.deferrals.proposeDiscount(f.actor, key(), { ...input, kind, servicesUnchanged: true })
    : service.deferrals.proposeCreditNote(f.actor, key(), { ...input, kind, cancelFrom: date });
}
async function forgedReview(
  f: Fixture,
  original: Awaited<ReturnType<typeof request>>,
  mutate: (body: DeferralRescheduleEffect) => void,
) {
  const effect = structuredClone(original.effect);
  mutate(effect);
  const input = Object.fromEntries(
    Object.keys(original.input).map((name) => [
      name,
      effect[name as keyof DeferralRescheduleEffect],
    ]),
  );
  const [row] = await db.orm
    .insert(actionReviews)
    .values({
      companyId: f.company.id,
      id: key(),
      operation: 'deferrals.reschedule',
      input,
      effect,
      hash: sha256(canonical(effect)),
      createdBy: ownerId,
    })
    .returning();
  await db.orm
    .update(actionReviews)
    .set({ approvedBy: ownerId, approvedAt: new Date().toISOString() })
    .where(eq(actionReviews.id, row.id));
  return { row, effect };
}
async function insertSchedule(f: Fixture, row: { id: string }, effect: DeferralRescheduleEffect) {
  return db.orm.insert(deferralReschedules).values({
    companyId: f.company.id,
    id: row.id,
    deferralId: effect.deferralId,
    sequence: effect.sequence,
    date: effect.date,
    evidenceId: effect.evidenceId,
    body: effect,
    createdBy: ownerId,
  });
}
async function injected(f: Fixture, body: GeneralBody) {
  return db.write(async (tx) => {
    const factId = key(),
      hash = sha256(canonical({ kind: 'general', version: 1, body, factId }));
    await tx.insert(facts).values({
      id: factId,
      companyId: f.company.id,
      kind: 'general',
      evidenceId: body.evidenceId,
      body,
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
}

describe('reviewed prospective subscription calendars', () => {
  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: preserve January and the exact remaining value, without posting an amendment journal',
    async ({ direction }) => {
      const f = await fixture('normal_vat', { direction });
      await release(f, '2026-01-01');
      await statement(f, '2026-01-01', '2026-01-31');
      await service.periods.close(f.actor, key(), '2026-01-01');
      const original = await books(f),
        plan = await request(f);
      expect(plan.effect.afterSchedule.map((row) => row.amount)).toEqual([
        '33.33',
        '22.22',
        '22.22',
        '22.23',
      ]);
      expect(plan.effect.amount).toBe('66.67');
      await expect(
        service.reviews.execute(f.actor, key(), { id: plan.review.id, hash: plan.review.hash }),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      const result = await apply(f, { id: plan.review.id, hash: plan.review.hash });
      expect(result.result).toMatchObject({ kind: 'rescheduled', id: plan.review.id, version: 1 });
      expect(await books(f)).toEqual(original);
      expect(
        (await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-01-31' })).serviceTo,
      ).toBe('2026-03-31');
      expect(
        await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-04-30' }),
      ).toMatchObject({
        amount: '100.00',
        allocated: '33.33',
        remaining: '66.67',
        serviceTo: '2026-04-30',
        reschedule: { id: plan.review.id, version: 1 },
      });
      for (const month of ['2026-02-01', '2026-03-01', '2026-04-01']) await release(f, month);
      expect(await balance(f)).toMatchObject(
        direction === 'purchase'
          ? { '471': '0.00', '628': '100.00', '4426': '21.00' }
          : { '472': '0.00', '704': '-100.00', '4427': '-21.00' },
      );
      expect(
        await service.deferrals.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-04-30',
        }),
      ).toMatchObject({ status: 'reconciled' });
    },
  );

  test('a removed monthly draft stays superseded after a later calendar restores the month', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const old = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: f.root.id,
      month: '2026-03-01',
    });
    await service.books.approve(f.actor, key(), old.id, { version: old.version, hash: old.hash });
    const a = await request(f, { serviceTo: '2026-02-28' });
    await apply(f, { id: a.review.id, hash: a.review.hash });
    expect(await service.queries.proposal(f.actor, old.id)).toMatchObject({
      superseded: true,
      posted: false,
    });
    const b = await request(f, { serviceTo: '2026-03-31' });
    await apply(f, { id: b.review.id, hash: b.review.hash });
    expect(await service.queries.proposal(f.actor, old.id)).toMatchObject({ superseded: true });
    const fresh = await service.deferrals.proposeRelease(
      f.actor,
      key(),
      { financialYearId: f.financialYear.id, deferralId: f.root.id, month: '2026-03-01' },
      { id: old.id, version: old.version },
    );
    await expect(service.ledger.post(f.actor, key(), exact(fresh))).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await post(f.actor, fresh);
    expect(generalBodySchema.parse(fresh.body).deferralRelease).toMatchObject({
      rescheduleId: b.review.id,
      rescheduleVersion: 2,
      amount: '33.34',
    });
  });

  test.each([
    {
      direction: 'purchase' as const,
      deduction: 'none' as const,
      vat: 'non_vat' as const,
      cost: '121.00',
      first: '40.33',
      tail: ['26.89', '26.89', '26.89'],
    },
    {
      direction: 'sale' as const,
      deduction: 'none' as const,
      vat: 'non_vat' as const,
      cost: '100.00',
      first: '33.33',
      tail: ['22.22', '22.22', '22.23'],
    },
    {
      direction: 'purchase' as const,
      deduction: 'none' as const,
      vat: 'normal_vat' as const,
      cost: '121.00',
      first: '40.33',
      tail: ['26.89', '26.89', '26.89'],
    },
  ])(
    '$vat $direction $deduction: only the future cost is redistributed',
    async ({ direction, deduction, vat, cost, first, tail }) => {
      const f = await fixture(
        vat,
        direction === 'sale'
          ? { direction, category: 'O', tax: '0.00', gross: '100.00' }
          : { direction },
        { deduction },
      );
      await release(f, '2026-01-01');
      const a = await request(f);
      expect(a.effect.sourceAmount).toBe(cost);
      expect(a.effect.afterSchedule.map((row) => row.amount)).toEqual([first, ...tail]);
      await apply(f, { id: a.review.id, hash: a.review.hash });
      for (const month of ['2026-02-01', '2026-03-01', '2026-04-01']) await release(f, month);
      expect((await balance(f))[direction === 'purchase' ? '628' : '704']).toBe(
        direction === 'purchase' ? cost : `-${cost}`,
      );
    },
  );

  test('unrecognized prefix months retain their value and tiny amounts keep residual bani', async () => {
    const f = await fixture('non_vat', { category: 'O', net: '0.02', tax: '0.00', gross: '0.02' }),
      a = await request(f, {
        date: '2026-01-15',
        evidenceDate: '2026-01-15',
        effectiveFrom: '2026-03-01',
        serviceTo: '2026-05-31',
      });
    expect(a.effect.afterSchedule.map((row) => row.amount)).toEqual([
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.02',
    ]);
    await apply(f, { id: a.review.id, hash: a.review.hash });
    await release(f, '2026-05-01');
    expect((await balance(f))['471']).toBe('0.00');
    const other = await fixture(),
      b = await request(other, {
        date: '2026-01-15',
        evidenceDate: '2026-01-15',
        effectiveFrom: '2026-03-01',
        serviceTo: '2026-04-30',
      });
    expect(b.effect.amount).toBe('33.34');
    expect(b.effect.afterSchedule.map((row) => row.amount)).toEqual([
      '33.33',
      '33.33',
      '16.67',
      '16.67',
    ]);
    await apply(other, { id: b.review.id, hash: b.review.hash });
    await release(other, '2026-01-01');
  });

  test('an approved old monthly amount cannot post after rescheduling, including direct database posting', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const old = await service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.financialYear.id,
        deferralId: f.root.id,
        month: '2026-02-01',
      }),
      approval = await service.books.approve(f.actor, key(), old.id, {
        version: old.version,
        hash: old.hash,
      });
    const a = await request(f);
    await apply(f, { id: a.review.id, hash: a.review.hash });
    await expect(service.ledger.post(f.actor, key(), exact(old))).rejects.toThrow();
    const body = generalBodySchema.parse(old.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: old.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const revised = await service.deferrals.proposeRelease(
      f.actor,
      key(),
      { financialYearId: f.financialYear.id, deferralId: f.root.id, month: '2026-02-01' },
      { id: old.id, version: old.version },
    );
    expect(generalBodySchema.parse(revised.body).deferralRelease).toMatchObject({
      amount: '22.22',
      rescheduleId: a.review.id,
      rescheduleVersion: 1,
    });
    await post(f.actor, revised);
  });

  test('competing reviewed calendars execute once and remove superseded alternatives from close blockers', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const a = await request(f),
      b = await request(f, { serviceTo: '2026-05-31' }),
      input = { id: a.review.id, hash: a.review.hash };
    await service.reviews.approve(f.actor, key(), input);
    await service.reviews.approve(f.actor, key(), { id: b.review.id, hash: b.review.hash });
    const k = key(),
      [x, y] = await Promise.all([
        service.reviews.execute(f.actor, k, input),
        service.reviews.execute(f.actor, k, input),
      ]);
    expect(x).toEqual(y);
    expect(await service.reviews.execute(f.actor, key(), input)).toEqual(x);
    await expect(
      service.reviews.execute(f.actor, key(), { id: b.review.id, hash: b.review.hash }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(
      (await service.queries.reviews(f.actor, { status: 'superseded' })).items.map((row) => row.id),
    ).toContain(b.review.id);
    expect((await service.overview(f.actor)).rescheduleReviews).toHaveLength(0);
    await release(f, '2026-02-01');
    await statement(f, '2026-02-01', '2026-02-28');
    await service.periods.close(f.actor, key(), '2026-02-01');
  });

  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: discounts keep the amended plan, cancellation uses its future months',
    async ({ direction }) => {
      const f = await fixture('normal_vat', { direction });
      await release(f, '2026-01-01');
      const a = await request(f);
      await apply(f, { id: a.review.id, hash: a.review.hash });
      await post(f.actor, await credit(f, 'commercial_discount'));
      expect(
        (await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-28' })).remaining,
      ).toBe('66.67');
      const cancellation = await credit(f, 'cancellation', '66.67', '14.00', '80.67'),
        body = generalBodySchema.parse(cancellation.body);
      expect(body.invoice?.deferralCredit).toMatchObject({
        rescheduleId: a.review.id,
        rescheduleVersion: 1,
        amount: '66.67',
        months: [
          { month: '2026-02-01', amount: '22.22' },
          { month: '2026-03-01', amount: '22.22' },
          { month: '2026-04-01', amount: '22.23' },
        ],
      });
      await post(f.actor, cancellation);
      expect((await balance(f))[direction === 'purchase' ? '471' : '472']).toBe('0.00');
      expect((await balance(f))[direction === 'purchase' ? '609' : '709']).toBe(
        direction === 'purchase' ? '-10.00' : '10.00',
      );
      await expect(request(f)).rejects.toMatchObject({ code: 'DEFERRAL_ALREADY_CANCELLED' });
    },
  );

  test('a posted discount invalidates a calendar approval; repriced evidence cannot reuse the stale review', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const a = await request(f),
      input = { id: a.review.id, hash: a.review.hash };
    await service.reviews.approve(f.actor, key(), input);
    await post(f.actor, await credit(f, 'commercial_discount'));
    await expect(service.reviews.execute(f.actor, key(), input)).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    const fresh = await request(f);
    await apply(f, { id: fresh.review.id, hash: fresh.review.hash });
    expect(fresh.effect.priorCreditCount).toBe(1);
  });

  test.each(['commercial_discount' as const, 'cancellation' as const])(
    '%s approval prepared against the old calendar cannot post after amendment',
    async (kind) => {
      const f = await fixture();
      await release(f, '2026-01-01');
      const draft =
        kind === 'commercial_discount'
          ? await credit(f, kind)
          : await credit(f, kind, '66.67', '14.00', '80.67');
      const approval = await service.books.approve(f.actor, key(), draft.id, {
        version: draft.version,
        hash: draft.hash,
      });
      const a = await request(f);
      await apply(f, { id: a.review.id, hash: a.review.hash });
      await expect(service.ledger.post(f.actor, key(), exact(draft))).rejects.toThrow();
      const body = generalBodySchema.parse(draft.body);
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
    },
  );

  test('balanced monthly release with a forged current-plan link is rejected independently of the application', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const a = await request(f);
    await apply(f, { id: a.review.id, hash: a.review.hash });
    const draft = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: f.root.id,
      month: '2026-02-01',
    });
    const body = generalBodySchema.parse(draft.body);
    body.deferralRelease!.rescheduleId = key();
    const forged = await injected(f, body);
    const approval = await service.books.approve(f.actor, key(), forged.id, {
      version: forged.version,
      hash: forged.hash,
    });
    await expect(service.ledger.post(f.actor, key(), exact(forged))).rejects.toMatchObject({
      code: 'STALE_DEFERRAL_RELEASE',
    });
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
  });

  test.each([
    { label: 'partial start month', change: { effectiveFrom: '2026-02-02' } },
    { label: 'partial end month', change: { serviceTo: '2026-04-29' } },
    { label: 'late evidence', change: { evidenceDate: '2026-02-02' } },
    { label: 'retroactive change', change: { date: '2026-02-02' } },
    {
      label: 'outside existing calendar',
      change: { effectiveFrom: '2026-04-01', serviceTo: '2026-05-31' },
    },
    { label: 'unchanged calendar', change: { serviceTo: '2026-03-31' } },
    { label: 'unreviewed future fiscal period', change: { serviceTo: '2027-01-31' } },
    { label: 'changed price', change: { priceUnchanged: false } },
    { label: 'unsupported distribution', change: { method: 'by_days' } },
  ])('rejects $label', async ({ change }) => {
    const f = await fixture();
    await release(f, '2026-01-01');
    await expect(request(f, change as Partial<DeferralRescheduleInput>)).rejects.toThrow();
  });

  test('missing past allocations, touched posted months and closed future months block changes', async () => {
    const f = await fixture();
    await expect(request(f)).rejects.toMatchObject({ code: 'DEFERRAL_ALLOCATION_DUE' });
    await release(f, '2026-01-01');
    await release(f, '2026-02-01');
    await expect(request(f)).rejects.toMatchObject({ code: 'DEFERRAL_EVENT_ORDER' });
    const other = await fixture(
      'non_vat',
      { category: 'O', net: '0.01', tax: '0.00', gross: '0.01' },
      { serviceTo: '2026-05-31' },
    );
    await statement(other, '2026-04-01', '2026-04-30');
    await service.periods.close(other.actor, key(), '2026-04-01');
    await expect(request(other, { serviceTo: '2026-06-30' })).rejects.toMatchObject({
      code: 'CLOSED_PERIOD',
    });
  });

  test('cross-company evidence, original agreement reuse and stale exact hashes are rejected', async () => {
    const f = await fixture(),
      other = await fixture();
    await release(f, '2026-01-01');
    await expect(request(f, { evidenceId: other.proof.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(request(f, { evidenceId: f.proof.id })).rejects.toMatchObject({
      code: 'DEFERRAL_RESCHEDULE_EVIDENCE',
    });
    const a = await request(f);
    await expect(
      service.reviews.approve(f.actor, key(), { id: a.review.id, hash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(
      service.reviews.reject(other.actor, key(), {
        id: a.review.id,
        hash: a.review.hash,
        reason: 'This review belongs to a different company',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await apply(f, { id: a.review.id, hash: a.review.hash });
    await expect(
      request(f, { serviceTo: '2026-05-31', evidenceId: a.proof.id }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_RESCHEDULE_EVIDENCE' });
  });

  test('independent database guards reject forged budgets, prefix, month order and source lineage even with approval', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const a = await request(f);
    const mutations: Array<(b: DeferralRescheduleEffect) => void> = [
      (b) => {
        b.afterSchedule[0].amount = '33.32';
        b.afterSchedule[3].amount = '22.24';
      },
      (b) => {
        b.afterSchedule[1].amount = '22.21';
        b.afterSchedule[3].amount = '22.24';
      },
      (b) => {
        b.afterSchedule[3].amount = '22.24';
      },
      (b) => {
        b.afterSchedule.reverse();
      },
      (b) => {
        b.afterSchedule[1].month = '2026-03-01';
      },
      (b) => {
        b.afterSchedule[1].date = '2026-02-27';
      },
      (b) => {
        b.beforeSchedule[1].amount = '1.00';
      },
      (b) => {
        b.sourceProposalHash = '0'.repeat(64);
      },
      (b) => {
        b.evidenceHash = '0'.repeat(64);
      },
      (b) => {
        b.sourceAmount = '99.00';
      },
      (b) => {
        b.priorReleaseCount = 0;
      },
      (b) => {
        b.allocated = '33.32';
      },
      (b) => {
        b.sequence = 2;
      },
      (b) => {
        b.priorRescheduleId = key();
      },
      (b) => {
        b.effectiveFrom = '2026-01-01';
      },
      (b) => {
        b.priceUnchanged = false as true;
      },
    ];
    for (const mutate of mutations) {
      const forged = await forgedReview(f, a, mutate);
      await expect(insertSchedule(f, forged.row, forged.effect)).rejects.toThrow();
    }
    expect(
      await db.orm
        .select()
        .from(deferralReschedules)
        .where(eq(deferralReschedules.companyId, f.company.id)),
    ).toHaveLength(0);
    await apply(f, { id: a.review.id, hash: a.review.hash });
    await expect(
      db.orm
        .update(deferralReschedules)
        .set({ date: '2026-02-02' })
        .where(eq(deferralReschedules.id, a.review.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm.delete(deferralReschedules).where(eq(deferralReschedules.id, a.review.id)).execute(),
    ).rejects.toThrow();
  });

  test('null or invented action outcomes cannot bypass approval, rejection or immutable completion', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const a = await request(f),
      when = new Date().toISOString();
    for (const result of [
      {},
      { kind: 'declined' },
      { kind: 'declined', reason: 'missing responsible reviewer', decidedAt: when },
      { kind: 'rescheduled', id: a.review.id, deferralId: f.root.id, version: 1 },
    ])
      await expect(
        db.orm
          .update(actionReviews)
          .set({ result, executedAt: when })
          .where(eq(actionReviews.id, a.review.id))
          .execute(),
      ).rejects.toThrow();
    await service.reviews.approve(f.actor, key(), { id: a.review.id, hash: a.review.hash });
    await expect(
      db.orm
        .update(actionReviews)
        .set({
          result: { kind: 'rescheduled', id: a.review.id, deferralId: f.root.id, version: 1 },
          executedAt: when,
        })
        .where(eq(actionReviews.id, a.review.id))
        .execute(),
    ).rejects.toThrow();
    await service.reviews.reject(f.actor, key(), {
      id: a.review.id,
      hash: a.review.hash,
      reason: 'The final agreement was withdrawn before execution',
    });
    await expect(insertSchedule(f, { id: a.review.id }, a.effect)).rejects.toThrow();
    await expect(
      db.orm
        .update(actionReviews)
        .set({ executedAt: null, result: null })
        .where(eq(actionReviews.id, a.review.id))
        .execute(),
    ).rejects.toThrow();
  });

  test('the original invoice year remains linked when the future calendar is approved in the next year', async () => {
    const original = await fixture(
        'normal_vat',
        { date: '2025-12-10' },
        { serviceFrom: '2026-01-01', serviceTo: '2026-03-31' },
        2025,
      ),
      year = await service.foundation.createYear(original.actor, key(), {
        kind: 'financial',
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      }),
      f = { ...original, financialYear: year };
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: year.id,
        evidenceId: f.proof.id,
        date: year.from,
        purpose: 'opening',
        description: 'Agreed year-end carry-forward',
        sourceReference: 'opening2026',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '471', debit: '100.00', credit: '0.00' },
          { account: '4426', debit: '21.00', credit: '0.00' },
          { account: '401', debit: '0.00', credit: '121.00' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
        ],
      }),
    );
    await release(f, '2026-01-01');
    const a = await request(f);
    expect(a.effect.sourceFinancialYearId).toBe(original.financialYear.id);
    await apply(f, { id: a.review.id, hash: a.review.hash });
    await release(f, '2026-02-01');
    expect((await service.overview(f.actor, year.id)).rescheduleReviews).toHaveLength(0);
    expect(
      await service.deferrals.reconcile(f.actor, { financialYearId: year.id, date: '2026-02-28' }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('revoked human approval cannot be executed by another reviewer', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const a = await request(f),
      input = { id: a.review.id, hash: a.review.hash };
    await service.reviews.approve(f.actor, key(), input);
    const user = (
        await createAuth(
          db,
          { publicUrl: 'http://localhost:3000', authSecret: secret },
          true,
        ).api.signUpEmail({
          body: {
            name: 'Second reviewer',
            email: `${key()}@example.test`,
            password: 'synthetic-reviewer-password',
          },
        })
      ).user,
      actor = { companyId: f.company.id, actorId: user.id };
    await db.orm
      .insert(memberships)
      .values({ companyId: f.company.id, userId: user.id, role: 'reviewer', active: true });
    await db.orm.update(memberships).set({ active: false }).where(eq(memberships.userId, ownerId));
    try {
      await expect(service.reviews.execute(actor, key(), input)).rejects.toThrow();
      await expect(insertSchedule(f, { id: a.review.id }, a.effect)).rejects.toThrow();
    } finally {
      await db.orm.update(memberships).set({ active: true }).where(eq(memberships.userId, ownerId));
    }
  });

  test('large exact values, idempotent preparation, exports and fresh restore preserve the approved non-posting event', async () => {
    const f = await fixture('non_vat', {
      category: 'O',
      net: '90071992547409.95',
      tax: '0.00',
      gross: '90071992547409.95',
    });
    await release(f, '2026-01-01');
    const a = await request(f),
      requestKey = key(),
      input = { operation: 'deferrals.reschedule' as const, input: a.input },
      [first, second] = await Promise.all([
        service.reviews.request(f.actor, requestKey, input),
        service.reviews.request(f.actor, requestKey, input),
      ]);
    expect(first).toEqual(second);
    expect(a.effect.afterSchedule.map((row) => row.amount)).toEqual([
      '30023997515803.31',
      '20015998343868.88',
      '20015998343868.88',
      '20015998343868.88',
    ]);
    const review = { id: first.id, hash: first.hash };
    await apply(f, review);
    const executeKey = key(),
      outcome = await service.reviews.execute(f.actor, executeKey, review);
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.deferralReschedules).toHaveLength(1);
    expect(exported.deferralReschedules[0].body).toEqual(a.effect);
    await backup(db, objects, join(directory, 'reschedule-backup'));
    const restored = await restore(
        join(directory, 'reschedule-backup'),
        join(directory, 'reschedule-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.reviews.execute(f.actor, executeKey, review)).toEqual(outcome);
      expect(await copy.reviews.request(f.actor, requestKey, input)).toEqual(first);
      expect(
        (await copy.deferrals.get(f.actor, { id: f.root.id, date: '2026-04-30' })).reschedule,
      ).toMatchObject({ id: first.id, version: 1 });
      expect((await copy.documents.read(f.actor, a.proof.id)).bytes).toEqual(
        (await service.documents.read(f.actor, a.proof.id)).bytes,
      );
    } finally {
      await copyDb.close();
    }
  });

  test('official MCP SDK prepares the calendar while exact human approval and rejection remain unavailable to agents', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const a = await request(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Subscription calendar assistant',
        scopes: ['deferrals.proposeReschedule', 'reviews.execute'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'reschedule-contract', version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${publicUrl}/api/accounting/v1/companies/${f.company.id}/mcp`),
        {
          authProvider: { token: async () => grant.token },
          fetch: async (url, init) => {
            const req = new Request(url, init);
            req.headers.set('host', new URL(req.url).host);
            return app.fetch(req);
          },
        },
      ),
    );
    try {
      const names = (await client.listTools()).tools.map((row) => row.name);
      expect(names).toContain('deferrals.proposeReschedule');
      expect(names).not.toContain('reviews.approve');
      expect(names).not.toContain('reviews.reject');
      const review = reviewOutput.parse(
          (
            await client.callTool({
              name: 'deferrals.proposeReschedule',
              arguments: { input: a.input, idempotencyKey: key() },
            })
          ).structuredContent,
        ),
        input = { id: review.id, hash: review.hash };
      expect(
        (
          await client.callTool({
            name: 'reviews.execute',
            arguments: { input, idempotencyKey: key() },
          })
        ).isError,
      ).toBe(true);
      await service.reviews.approve(f.actor, key(), input);
      expect(
        (
          await client.callTool({
            name: 'reviews.execute',
            arguments: { input, idempotencyKey: key() },
          })
        ).isError,
      ).not.toBe(true);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(
        client.callTool({
          name: 'deferrals.proposeReschedule',
          arguments: { input: a.input, idempotencyKey: key() },
        }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test('a due unresolved calendar blocks close; a human rejection closes only the review', async () => {
    const f = await fixture();
    await release(f, '2026-01-01');
    const plan = await request(f);
    await expect(service.periods.close(f.actor, key(), '2026-02-01')).rejects.toMatchObject({
      code: 'DEFERRAL_RESCHEDULE_PENDING',
    });
    const declined = await service.reviews.reject(f.actor, key(), {
      id: plan.review.id,
      hash: plan.review.hash,
      reason: 'The proposed agreement was not accepted by both parties',
    });
    expect(declined.result).toMatchObject({ kind: 'declined' });
    expect(
      await service.reviews.execute(f.actor, key(), { id: plan.review.id, hash: plan.review.hash }),
    ).toEqual(declined);
    expect((await service.queries.reviews(f.actor, { status: 'pending' })).items).toHaveLength(0);
    expect(
      await db.orm
        .select()
        .from(deferralReschedules)
        .where(eq(deferralReschedules.companyId, f.company.id)),
    ).toHaveLength(0);
    await release(f, '2026-02-01');
    await statement(f, '2026-02-01', '2026-02-28');
    await service.periods.close(f.actor, key(), '2026-02-01');
  });
});
