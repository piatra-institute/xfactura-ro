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
  type DeferralScopeReductionInput,
  type DeferralRescheduleEffect,
  type DeferralRescheduleInput,
  type GeneralBody,
} from '../../source/accounting/domain';
import {
  facts,
  proposals,
  deferralPostings,
  deferralCancellations,
  deferralReleases,
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
  secret = 'synthetic-scope-reduction-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-scope-reductions-'));
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
        email: 'scope-reductions@example.test',
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
  commandKey = key(),
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
      `Original contract: uniform daily benefits, inclusive calendar-day dates ${company.id}`,
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
      basis: 'uniform_service',
      method: 'actual_calendar_days',
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
async function release(f: Fixture, root: Root, month: string, year = f.financialYear.id) {
  const p = await service.deferrals.proposeRelease(f.actor, key(), {
    financialYearId: year,
    deferralId: root.proposal.id,
    month,
  });
  return { proposal: p, ...(await post(f.actor, p)) };
}
async function balance(f: Fixture, year = f.financialYear.id) {
  return Object.fromEntries(
    (await service.ledger.balance(f.actor, { financialYearId: year })).balances.map((row) => [
      row.account,
      row.closing,
    ]),
  );
}
async function amend(f: Fixture, root: Root, change: Partial<DeferralRescheduleInput> = {}) {
  const proof = await source(
      f.actor,
      `Separate agreement: prospective daily calendar change ${key()}`,
    ),
    input: DeferralRescheduleInput = {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      date: '2026-02-01',
      effectiveFrom: '2026-02-01',
      serviceTo: '2026-04-10',
      evidenceId: proof.id,
      evidenceDate: '2026-02-01',
      method: 'actual_calendar_days',
      priceUnchanged: true,
      reason:
        'Future daily service duration changes while the remaining contract value is preserved',
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
async function statement(f: Fixture, month = '2026-01-01', end = '2026-01-31') {
  const file = await source(
    f.actor,
    'movement_id,booking_date,amount,currency,reference\n',
    'statement.csv',
  );
  return service.bank.importStatement(f.actor, key(), {
    evidenceId: file.id,
    bankAccount: 'RO00DAYS',
    statementId: key(),
    from: month,
    to: end,
    opening: '1000.00',
    closing: '1000.00',
  });
}
async function credit(
  f: Fixture,
  root: Root,
  kind: 'commercial_discount' | 'cancellation',
  net = '10.00',
  tax = '2.10',
  gross = '12.10',
) {
  const proof = await source(f.actor, `Separately evidenced credit agreement ${key()}`),
    file = await source(
      f.actor,
      invoiceXml({
        direction: root.invoice.direction,
        credit: true,
        number: key(),
        originalNumber: root.invoice.body.number,
        date: '2026-02-01',
        net,
        tax,
        gross,
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
      treatmentEvidenceId: proof.id,
      kind,
      periodBasis: 'current_period_event' as const,
      reason: 'A new agreement changes the price or cancels only future unprovided services',
    };
  return kind === 'commercial_discount'
    ? service.deferrals.proposeDiscount(f.actor, key(), { ...input, kind, servicesUnchanged: true })
    : service.deferrals.proposeCreditNote(f.actor, key(), {
        ...input,
        kind,
        cancelFrom: '2026-02-01',
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

async function scopeCredit(
  f: Fixture,
  root: Root,
  xml: XmlInput = {},
  change: Partial<DeferralScopeReductionInput> = {},
) {
  const noVatSale = f.vat === 'non_vat' && root.invoice.direction === 'sale';
  const proof = await source(
    f.actor,
    `Signed new agreement cancels part of future services; the remaining benefits stay uniform ${key()}`,
  );
  const file = await source(
    f.actor,
    invoiceXml({
      direction: root.invoice.direction,
      credit: true,
      originalNumber: root.invoice.body.number,
      number: key(),
      date: '2026-02-01',
      net: '20.00',
      tax: noVatSale ? '0.00' : '4.20',
      gross: noVatSale ? '20.00' : '24.20',
      ...(noVatSale ? { category: 'O' } : {}),
      ...xml,
    }),
    'scope-credit.xml',
  );
  const invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  const input: DeferralScopeReductionInput = {
    financialYearId: f.financialYear.id,
    originalInvoiceId: root.invoice.id,
    invoiceId: invoice.id,
    recognitionDate: invoice.body.issueDate,
    decisionDate: invoice.body.issueDate,
    treatmentEvidenceId: proof.id,
    kind: 'cancellation',
    periodBasis: 'current_period_event',
    cancelFrom: '2026-02-01',
    changeBasis: 'cancelled_future_services',
    remainingServices: 'uniform',
    reason:
      'New written agreement cancels only part of unprovided future services and retains uniform remaining benefits',
    ...change,
  };
  return { input, proof, invoice };
}
const scopePlan = (body: GeneralBody) => {
  const value = body.invoice?.deferralCredit;
  if (value?.schemaVersion !== 2) throw new Error('Expected scope reduction fixture');
  return value;
};

describe('credit-backed future-service scope reductions', () => {
  const scenarios = [
    { vat: 'normal_vat', direction: 'purchase', deduction: 'full', grossCost: false },
    { vat: 'non_vat', direction: 'purchase', deduction: 'none', grossCost: true },
    { vat: 'normal_vat', direction: 'sale', deduction: 'none', grossCost: false },
    { vat: 'non_vat', direction: 'sale', deduction: 'none', grossCost: false },
    { vat: 'normal_vat', direction: 'purchase', deduction: 'none', grossCost: true },
  ] as const;
  for (const method of ['equal_calendar_months', 'actual_calendar_days'] as const) {
    test.each(scenarios)(
      `${method}: $vat $direction $deduction preserves earned values and reduces only future scope`,
      async (s) => {
        const f = await fixture(s.vat);
        const root = await prepare(
          f,
          {
            direction: s.direction,
            ...(s.vat === 'non_vat' && s.direction === 'sale'
              ? { category: 'O', tax: '0.00', gross: '100.00' }
              : {}),
          },
          {
            method,
            basis: method === 'actual_calendar_days' ? 'uniform_service' : 'uniform_subscription',
            serviceFrom: method === 'actual_calendar_days' ? '2026-01-16' : '2026-01-01',
            serviceTo: method === 'actual_calendar_days' ? '2026-03-15' : '2026-03-31',
            deduction: s.deduction,
          },
        );
        await post(f.actor, root.proposal);
        await release(f, root, '2026-01-01');
        await statement(f);
        await service.periods.close(f.actor, key(), '2026-01-01');
        const original = await db.orm
          .select()
          .from(proposals)
          .where(eq(proposals.id, root.proposal.id));
        const c = await scopeCredit(f, root),
          p = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input);
        proposalOutput.parse(p);
        const body = generalBodySchema.parse(p.body),
          plan = scopePlan(body);
        const values =
          method === 'equal_calendar_months'
            ? s.grossCost
              ? ['40.33', '28.23', '28.24']
              : ['33.33', '23.33', '23.34']
            : s.grossCost
              ? ['32.81', '41.66', '22.33']
              : ['27.11', '34.44', '18.45'];
        expect(plan.afterSchedule.map((row) => row.amount)).toEqual(values);
        expect(plan.beforeSchedule[0]).toEqual(plan.afterSchedule[0]);
        expect(plan.amount).toBe(s.grossCost ? '24.20' : '20.00');
        expect(body.lines.some((row) => row.account === '609' || row.account === '709')).toBe(
          false,
        );
        await post(f.actor, p);
        expect(
          await db.orm.select().from(proposals).where(eq(proposals.id, root.proposal.id)),
        ).toEqual(original);
        const january = await service.deferrals.get(f.actor, {
          id: root.proposal.id,
          date: '2026-01-31',
        });
        expect(january.cancelled).toBe('0.00');
        const after = deferralPositionOutput.parse(
          await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-01' }),
        );
        expect(after.cancellation).toMatchObject({
          kind: 'scope_reduction',
          amount: s.grossCost ? '24.20' : '20.00',
        });
        expect(after.schedule.slice(1).every((row) => row.status === 'scheduled')).toBe(true);
        await release(f, root, '2026-02-01');
        await release(f, root, '2026-03-01');
        const closed = await service.deferrals.get(f.actor, {
          id: root.proposal.id,
          date: '2026-03-31',
        });
        expect(closed).toMatchObject({
          allocated: s.grossCost ? '96.80' : '80.00',
          remaining: '0.00',
          status: 'allocated',
        });
        expect(closed.schedule.map((row) => row.amount)).toEqual(values);
        const ledger = await balance(f);
        expect(ledger[s.direction === 'purchase' ? '471' : '472']).toBe('0.00');
        expect(ledger[s.direction === 'purchase' ? '628' : '704']).toBe(
          s.direction === 'sale' ? '-80.00' : s.grossCost ? '96.80' : '80.00',
        );
        expect(
          await service.deferrals.reconcile(f.actor, {
            financialYearId: f.financialYear.id,
            date: '2026-03-31',
          }),
        ).toMatchObject({ status: 'reconciled' });
        const vat = await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          from: '2026-01-01',
          to: '2026-03-31',
        });
        expect(vat.status).toBe('reconciled');
      },
    );
  }

  test('a prepared monthly release becomes superseded and needs exact revision and fresh human approval', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    const old = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.financialYear.id,
      deferralId: root.proposal.id,
      month: '2026-02-01',
    });
    const approval = await service.books.approve(f.actor, key(), old.id, {
      version: old.version,
      hash: old.hash,
    });
    const c = await scopeCredit(f, root),
      p = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input);
    await post(f.actor, p);
    expect(await service.queries.proposal(f.actor, old.id)).toMatchObject({
      superseded: true,
      posted: false,
    });
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
      { financialYearId: f.financialYear.id, deferralId: root.proposal.id, month: '2026-02-01' },
      { id: old.id, version: old.version },
    );
    expect(generalBodySchema.parse(revised.body).deferralRelease).toMatchObject({
      amount: '34.44',
    });
    await expect(service.ledger.post(f.actor, key(), exact(revised))).rejects.toThrow();
    await post(f.actor, revised);
    expect(await service.queries.proposal(f.actor, revised.id)).toMatchObject({ posted: true });
  });

  test('the agreement must reduce future scope, leave a positive remainder and use separately retained evidence', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    const c = await scopeCredit(f, root);
    for (const change of [
      { remainingServices: 'nonuniform' },
      { changeBasis: 'commercial_discount' },
      { servicesUnchanged: true },
      { cancelFrom: '2026-02-02' },
      { cancelFrom: '2026-01-01' },
      { treatmentEvidenceId: root.input.evidenceId },
      { treatmentEvidenceId: c.invoice.evidenceId },
    ])
      await expect(
        (async () =>
          service.deferrals.proposeScopeReduction(f.actor, key(), { ...c.input, ...change }))(),
      ).rejects.toThrow();
    const all = await scopeCredit(f, root, { net: '72.89', tax: '15.31', gross: '88.20' });
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), all.input),
    ).rejects.toMatchObject({ code: 'DEFERRAL_CREDIT_AMOUNT' });
    const excessive = await scopeCredit(f, root, { net: '80.00', tax: '16.80', gross: '96.80' });
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), excessive.input),
    ).rejects.toMatchObject({ code: 'DEFERRAL_CREDIT_AMOUNT' });
    const other = await fixture();
    await expect(
      service.deferrals.proposeScopeReduction(other.actor, key(), c.input),
    ).rejects.toThrow();
  });

  test('due benefits, locked recognition months and unsupported registration paths block a scope amendment', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    const c = await scopeCredit(f, root);
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), c.input),
    ).rejects.toMatchObject({ code: 'DEFERRAL_ALLOCATION_DUE' });
    await release(f, root, '2026-01-01');
    await statement(f);
    await service.periods.close(f.actor, key(), '2026-01-01');
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), {
        ...c.input,
        recognitionDate: '2026-01-31',
      }),
    ).rejects.toThrow();
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'non_vat',
      effectiveFrom: '2026-02-10',
      evidenceId: f.proof.id,
    });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'normal_vat',
      effectiveFrom: '2026-02-20',
      evidenceId: f.proof.id,
    });
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), c.input),
    ).rejects.toMatchObject({ code: 'DEFERRAL_VAT_TRANSITION' });
    const locked = await fixture(),
      lockedRoot = await prepare(locked);
    await post(locked.actor, lockedRoot.proposal);
    for (const [month, end] of [
      ['2026-01-01', '2026-01-31'],
      ['2026-02-01', '2026-02-28'],
    ]) {
      await release(locked, lockedRoot, month);
      await statement(locked, month, end);
      await service.periods.close(locked.actor, key(), month);
    }
    const late = await scopeCredit(locked, lockedRoot, {}, { cancelFrom: '2026-03-01' });
    await expect(
      service.deferrals.proposeScopeReduction(locked.actor, key(), late.input),
    ).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
  });

  test('a 2025 scope reduction retains the original 19 percent tax point and has no allocation VAT', async () => {
    const f = await fixture('normal_vat', 2025),
      root = await prepare(
        f,
        { date: '2025-05-01', rate: '19', tax: '19.00', gross: '119.00' },
        { serviceFrom: '2025-05-16', serviceTo: '2025-07-15' },
      );
    await post(f.actor, root.proposal);
    await release(f, root, '2025-05-01');
    const c = await scopeCredit(
      f,
      root,
      { date: '2025-06-01', rate: '19', tax: '3.80', gross: '23.80' },
      { cancelFrom: '2025-06-01' },
    );
    const p = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input);
    expect(
      scopePlan(generalBodySchema.parse(p.body)).afterSchedule.map((row) => row.amount),
    ).toEqual(['26.22', '35.85', '17.93']);
    await post(f.actor, p);
    await release(f, root, '2025-06-01');
    await release(f, root, '2025-07-01');
    expect(await balance(f)).toMatchObject({ '471': '0.00', '628': '80.00', '4426': '15.20' });
    expect(
      await service.vat.summary(f.actor, {
        financialYearId: f.financialYear.id,
        from: '2025-07-01',
        to: '2025-07-31',
      }),
    ).toMatchObject({ totals: { inputTax: '0.00', outputTax: '0.00' }, status: 'reconciled' });
  });

  test('an intervening commercial credit invalidates an old scope approval and revised evidence requires fresh approval', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    const c = await scopeCredit(f, root),
      old = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input);
    await service.books.approve(f.actor, key(), old.id, { version: old.version, hash: old.hash });
    await post(f.actor, await credit(f, root, 'commercial_discount'));
    await expect(service.ledger.post(f.actor, key(), exact(old))).rejects.toThrow();
    const revised = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input, {
      id: old.id,
      version: old.version,
    });
    await expect(service.ledger.post(f.actor, key(), exact(revised))).rejects.toThrow();
    await post(f.actor, revised);
    await release(f, root, '2026-02-01');
    await release(f, root, '2026-03-01');
    expect(await balance(f)).toMatchObject({
      '471': '0.00',
      '628': '80.00',
      '609': '-10.00',
      '4426': '14.70',
    });
  });

  test('a timing amendment and later scope reduction use the current calendar without rewriting its recognized prefix', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    const c = await scopeCredit(f, root),
      pending = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input);
    await service.books.approve(f.actor, key(), pending.id, {
      version: pending.version,
      hash: pending.hash,
    });
    const a = await amend(f, root);
    await apply(f, { id: a.review.id, hash: a.review.hash });
    await expect(service.ledger.post(f.actor, key(), exact(pending))).rejects.toThrow();
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), {
        ...c.input,
        treatmentEvidenceId: a.proof.id,
      }),
    ).rejects.toThrow();
    const revised = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input, {
      id: pending.id,
      version: pending.version,
    });
    expect(
      scopePlan(generalBodySchema.parse(revised.body)).afterSchedule.map((row) => row.amount),
    ).toEqual(['27.11', '21.46', '23.76', '7.67']);
    await post(f.actor, revised);
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-01' }),
    ).toMatchObject({ serviceTo: '2026-04-10', allocation: { serviceDays: 85 } });
    const later = await amend(f, root, { serviceTo: '2026-05-10' });
    expect(later.effect.scopeCredit?.amount).toBe('20.00');
    await service.reviews.reject(f.actor, key(), {
      id: later.review.id,
      hash: later.review.hash,
      reason: 'The later extension is not agreed; preserve the current reduced calendar',
    });
    const again = await scopeCredit(f, root);
    await expect(
      service.deferrals.proposeScopeReduction(f.actor, key(), again.input),
    ).rejects.toMatchObject({ code: 'DEFERRAL_ALREADY_CANCELLED' });
    for (const month of ['2026-02-01', '2026-03-01', '2026-04-01']) await release(f, root, month);
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-04-30',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('independent database guards reject balanced forged scope budgets, history, day counts and allocation methods', async () => {
    for (const method of ['equal_calendar_months', 'actual_calendar_days'] as const) {
      const f = await fixture(),
        root = await prepare(
          f,
          {},
          {
            method,
            basis: method === 'actual_calendar_days' ? 'uniform_service' : 'uniform_subscription',
            serviceFrom: method === 'actual_calendar_days' ? '2026-01-16' : '2026-01-01',
            serviceTo: method === 'actual_calendar_days' ? '2026-03-15' : '2026-03-31',
          },
        );
      await post(f.actor, root.proposal);
      await release(f, root, '2026-01-01');
      const c = await scopeCredit(f, root),
        p = await service.deferrals.proposeScopeReduction(f.actor, key(), c.input),
        base = generalBodySchema.parse(p.body);
      const mutations: Array<(b: GeneralBody) => void> = [
        (b) => {
          scopePlan(b).remainingAfter = '1.00';
        },
        (b) => {
          scopePlan(b).amount = '19.00';
        },
        (b) => {
          scopePlan(b).allocated = '1.00';
        },
        (b) => {
          scopePlan(b).priorReleaseCount = 0;
        },
        (b) => {
          scopePlan(b).afterSchedule[0].amount = '1.00';
        },
        (b) => {
          scopePlan(b).afterSchedule[1].amount = '22.00';
          scopePlan(b).afterSchedule[2].amount = '24.67';
        },
        (b) => {
          scopePlan(b).afterSchedule.reverse();
        },
        (b) => {
          scopePlan(b).afterSchedule[1].month = '2026-01-01';
        },
        (b) => {
          scopePlan(b).afterSchedule[1].date = '2026-02-27';
        },
        (b) => {
          scopePlan(b).beforeSchedule[0].amount = '1.00';
        },
        (b) => {
          scopePlan(b).evidenceHash = '0'.repeat(64);
        },
        (b) => {
          Object.assign(scopePlan(b), { changeBasis: 'commercial_discount' });
        },
        (b) => {
          Object.assign(scopePlan(b), { schemaVersion: 1 });
        },
        (b) => {
          Object.assign(scopePlan(b), {
            method:
              method === 'actual_calendar_days' ? 'equal_calendar_months' : 'actual_calendar_days',
          });
        },
        (b) => {
          b.lines = b.lines.map((row) =>
            row.account === '471' ? { ...row, account: '609' } : row,
          );
          b.invoice!.account = '609';
        },
        ...(method === 'actual_calendar_days'
          ? [
              (b: GeneralBody) => {
                Object.assign(scopePlan(b).afterSchedule[1], { days: 27 });
              },
              (b: GeneralBody) => {
                Reflect.deleteProperty(scopePlan(b).afterSchedule[1], 'serviceFrom');
              },
            ]
          : []),
      ];
      for (const mutate of mutations) {
        const body = structuredClone(base);
        mutate(body);
        const forged = await injected(f, body),
          approval = await service.books.approve(f.actor, key(), forged.id, {
            version: forged.version,
            hash: forged.hash,
          });
        await expect(service.ledger.post(f.actor, key(), exact(forged))).rejects.toThrow();
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
        await db.orm
          .select()
          .from(deferralCancellations)
          .where(eq(deferralCancellations.companyId, f.company.id)),
      ).toHaveLength(0);
      await post(f.actor, p);
    }
  });

  test.each(['purchase', 'sale'] as const)(
    '%s: a paid invoice creates a refund and closing keeps reduced future benefits due',
    async (direction) => {
      const f = await fixture(),
        root = await prepare(f, { direction });
      await post(f.actor, root.proposal);
      async function movement(
        from: string,
        to: string,
        opening: string,
        closing: string,
        amount: string,
        date: string,
      ) {
        const file = await source(
          f.actor,
          `movement_id,booking_date,amount,currency,reference\n${key()},${date},${amount},RON,Contract settlement\n`,
          'bank.csv',
        );
        await service.bank.importStatement(f.actor, key(), {
          evidenceId: file.id,
          bankAccount: 'RO00DAYS',
          statementId: key(),
          from,
          to,
          opening,
          closing,
        });
        return (await service.queries.movements(f.actor, { matched: false })).items[0];
      }
      const afterPay = direction === 'purchase' ? '879.00' : '1121.00';
      const payment = await movement(
        '2026-01-01',
        '2026-01-31',
        '1000.00',
        afterPay,
        direction === 'purchase' ? '-121.00' : '121.00',
        '2026-01-05',
      );
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: payment.id,
          allocations: [{ invoiceId: root.invoice.id, amount: '121.00' }],
        }),
      );
      await release(f, root, '2026-01-01');
      await service.periods.close(f.actor, key(), '2026-01-01');
      const c = await scopeCredit(f, root);
      await post(f.actor, await service.deferrals.proposeScopeReduction(f.actor, key(), c.input));
      expect(
        await service.positions.read(f.actor, { invoiceId: root.invoice.id, date: '2026-02-01' }),
      ).toMatchObject({ balance: '-24.20', status: 'refund_due' });
      const afterRefund = direction === 'purchase' ? '903.20' : '1096.80';
      const refund = await movement(
        '2026-02-01',
        '2026-02-28',
        afterPay,
        afterRefund,
        direction === 'purchase' ? '24.20' : '-24.20',
        '2026-02-10',
      );
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
      await release(f, root, '2026-02-01');
      await service.periods.close(f.actor, key(), '2026-02-01');
      await release(f, root, '2026-03-01');
      expect(await balance(f)).toMatchObject({
        '5121': afterRefund,
        [direction === 'purchase' ? '401' : '4111']: '0.00',
      });
    },
  );

  test('a cross-year scope credit requires carried 471 continuity and preserves prior-year cost and VAT', async () => {
    const f = await fixture('normal_vat', 2025),
      root = await prepare(
        f,
        { date: '2025-12-10' },
        { serviceFrom: '2025-12-16', serviceTo: '2026-01-15' },
      );
    await post(f.actor, root.proposal);
    await release(f, root, '2025-12-01');
    const year = await service.foundation.createYear(f.actor, key(), {
      kind: 'financial',
      label: '2026',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const c = await scopeCredit(
      f,
      root,
      { date: '2026-01-01' },
      { financialYearId: year.id, cancelFrom: '2026-01-01' },
    );
    await post(f.actor, await service.deferrals.proposeScopeReduction(f.actor, key(), c.input));
    expect(
      await service.deferrals.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-15' }),
    ).toMatchObject({ status: 'needs_review', prepaid: { difference: '-48.39' } });
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: year.id,
        evidenceId: f.proof.id,
        date: year.from,
        purpose: 'opening',
        description: 'Approved independent year-opening carry',
        sourceReference: 'opening-2026',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '471', debit: '48.39', credit: '0.00' },
          { account: '4426', debit: '21.00', credit: '0.00' },
          { account: '1171', debit: '51.61', credit: '0.00' },
          { account: '401', debit: '0.00', credit: '121.00' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
        ],
      }),
    );
    await release(f, root, '2026-01-01', year.id);
    expect(await balance(f)).toMatchObject({ '628': '51.61', '4426': '21.00' });
    expect(await balance(f, year.id)).toMatchObject({
      '471': '0.00',
      '628': '28.39',
      '4426': '16.80',
    });
    expect(
      await service.deferrals.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-31' }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('concurrent retries, exact large bani, exports and fresh restore retain one scope credit and immutable plans', async () => {
    const f = await fixture('non_vat'),
      root = await prepare(f, {
        direction: 'sale',
        category: 'O',
        net: '9007199254740999.95',
        tax: '0.00',
        gross: '9007199254740999.95',
      });
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    const c = await scopeCredit(f, root, {
        net: '1000000000000000.01',
        tax: '0.00',
        gross: '1000000000000000.01',
      }),
      commandKey = key();
    const [a, b] = await Promise.all([
      service.deferrals.proposeScopeReduction(f.actor, commandKey, c.input),
      service.deferrals.proposeScopeReduction(f.actor, commandKey, c.input),
    ]);
    expect(a).toEqual(b);
    const postKey = key(),
      posted = await post(f.actor, a, postKey);
    await release(f, root, '2026-02-01');
    await release(f, root, '2026-03-01');
    const state = await service.deferrals.get(f.actor, {
      id: root.proposal.id,
      date: '2026-03-31',
    });
    expect(state).toMatchObject({
      amount: '9007199254740999.95',
      allocated: '8007199254740999.94',
      cancelled: '1000000000000000.01',
      remaining: '0.00',
    });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.deferralCancellations).toHaveLength(1);
    expect(exported.deferralCancellations[0].amountBani).toBe('100000000000000001');
    await backup(db, objects, join(directory, 'scope-backup'));
    const restored = await restore(
        join(directory, 'scope-backup'),
        join(directory, 'scope-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.deferrals.proposeScopeReduction(f.actor, commandKey, c.input)).toEqual(a);
      expect(await copy.ledger.post(f.actor, postKey, exact(a))).toEqual(posted.entry);
      expect(
        await copy.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
      ).toEqual(state);
      expect((await copy.documents.read(f.actor, c.proof.id)).bytes).toEqual(
        (await service.documents.read(f.actor, c.proof.id)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(deferralCancellations)
          .where(eq(deferralCancellations.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
    } finally {
      await copyDb.close();
    }
  });

  test('official MCP prepares and revises a scope credit, pauses for human approval and honors revoked authority', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
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
      });
    const app = createApp(service, { publicUrl: 'http://localhost:3000', authSecret: secret }).app;
    const client = new Client(
      { name: 'scope-contract', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://localhost:3000/api/accounting/v1/companies/${f.company.id}/mcp`),
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
    const call = (name: string, input: unknown, idempotencyKey = key()) =>
      client.callTool({ name, arguments: { input, idempotencyKey } });
    try {
      const names = (await client.listTools()).tools.map((row) => row.name);
      expect(names).toContain('deferrals.proposeScopeReduction');
      expect(names).not.toContain('books.approve');
      const a = proposalOutput.parse(
        (await call('deferrals.proposeScopeReduction', c.input)).structuredContent,
      );
      expect((await call('ledger.post', exact(a))).isError).toBe(true);
      await service.books.approve(f.actor, key(), a.id, { version: a.version, hash: a.hash });
      const b = proposalOutput.parse(
        (
          await call('deferrals.reviseScopeReduction', {
            ...c.input,
            id: a.id,
            version: a.version,
            reason:
              'Updated independently reviewed description of the reduced future service scope',
          })
        ).structuredContent,
      );
      expect((await call('ledger.post', exact(b))).isError).toBe(true);
      await service.books.approve(f.actor, key(), b.id, { version: b.version, hash: b.hash });
      const postKey = key(),
        posted = await call('ledger.post', exact(b), postKey);
      expect(posted.isError).not.toBe(true);
      const state = deferralPositionOutput.parse(
        (await call('deferrals.get', { id: root.proposal.id, date: '2026-02-01' }))
          .structuredContent,
      );
      expect(state).toMatchObject({ cancelled: '20.00', remaining: '52.89' });
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(call('ledger.post', exact(b), postKey)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
