import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Accounting } from '../../source/accounting/application';
import { createAuth } from '../../source/accounting/auth';
import { createApp } from '../../source/accounting/app';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import {
  canonical,
  deferralRescheduleEffect,
  generalBodySchema,
  type DeferralInput,
  type DeferralRescheduleEffect,
  type DeferralRescheduleInput,
} from '../../source/accounting/domain';
import {
  deferralPositionOutput,
  proposalOutput,
  reviewOutput,
} from '../../source/accounting/capability-contracts';
import {
  actionReviews,
  deferralReschedules,
  journals,
  journalLines,
  evidence,
} from '../../source/accounting/schema';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml } from './fixtures/invoice';

const key = () => randomUUID(),
  secret = 'synthetic-reduced-calendar-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-reduced-calendars-'));
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
        name: 'Reduced calendar reviewer',
        email: 'reduced-calendars@example.test',
        password: 'synthetic-calendar-password',
      },
    })
  ).user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const exact = (p: { id: string; version: number; hash: string }) => ({
  id: p.id,
  version: p.version,
  hash: p.hash,
});
async function post(
  actor: { actorId: string; companyId: string },
  p: { id: string; version: number; hash: string },
  commandKey: string = key(),
) {
  await service.books.approve(actor, key(), p.id, { version: p.version, hash: p.hash });
  return service.ledger.post(actor, commandKey, exact(p));
}
async function source(
  actor: { actorId: string; companyId: string },
  contents: string,
  filename = 'agreement.txt',
) {
  return service.documents.record(actor, key(), {
    filename,
    mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
    bytes: Buffer.from(contents),
  });
}
function benefits(amounts: string[], start = 0) {
  return amounts.map((amount, index) => ({
    month: new Date(Date.UTC(2026, start + index, 1)).toISOString().slice(0, 10),
    amount,
    benefit: `Documented service benefit ${start + index + 1}`,
  }));
}
type Method = DeferralInput['method'];
async function fixture(
  method: Method = 'actual_calendar_days',
  vat: 'normal_vat' | 'non_vat' = 'normal_vat',
  direction: 'purchase' | 'sale' = 'purchase',
  deduction: 'full' | 'none' = 'full',
) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Reduced services SRL',
      cui: '12345678',
      year: 2026,
    }),
    actor = { companyId: company.id, actorId: ownerId },
    year = (await service.foundation.years(actor)).find((row) => row.kind === 'financial')!,
    contract = await source(actor, `Original evidenced service benefits ${company.id}`),
    noVatSale = vat === 'non_vat' && direction === 'sale',
    irrecoverable = direction === 'purchase' && (vat === 'non_vat' || deduction === 'none');
  await service.foundation.recordRegime(actor, key(), {
    axis: 'vat',
    value: vat,
    effectiveFrom: '2026-01-01',
    evidenceId: contract.id,
  });
  if (vat === 'normal_vat')
    await service.foundation.recordRegime(actor, key(), {
      axis: 'vat_collection',
      value: 'no',
      effectiveFrom: '2026-01-01',
      evidenceId: contract.id,
    });
  await post(
    actor,
    await service.ledger.propose(actor, key(), {
      financialYearId: year.id,
      evidenceId: contract.id,
      date: year.from,
      purpose: 'opening',
      description: 'Documented opening',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  const xml = await source(
      actor,
      invoiceXml({
        number: key(),
        date: '2026-01-01',
        direction,
        ...(noVatSale ? { category: 'O', tax: '0.00', gross: '100.00' } : {}),
      }),
      'invoice.xml',
    ),
    invoice = await service.invoices.import(actor, key(), { evidenceId: xml.id }),
    input: DeferralInput = {
      financialYearId: year.id,
      invoiceId: invoice.id,
      recognitionDate: '2026-01-01',
      evidenceId: contract.id,
      evidenceDate: '2026-01-01',
      taxPointBasis: 'early_invoice',
      account: direction === 'purchase' ? '628' : '704',
      deduction: direction === 'purchase' && vat === 'normal_vat' ? deduction : 'none',
      counterpartyVatCollection: 'no',
      method,
      basis:
        method === 'equal_calendar_months'
          ? 'uniform_subscription'
          : method === 'actual_calendar_days'
            ? 'uniform_service'
            : 'documented_monthly_benefits',
      serviceFrom: method === 'equal_calendar_months' ? '2026-01-01' : '2026-01-16',
      serviceTo: method === 'equal_calendar_months' ? '2026-03-31' : '2026-03-15',
      reason: 'Original evidenced future service benefit under the selected allocation policy',
      ...(method === 'evidenced_monthly_amounts'
        ? {
            benefits: benefits(
              irrecoverable ? ['24.20', '60.50', '36.30'] : ['20.00', '50.00', '30.00'],
            ),
          }
        : {}),
    },
    root = await service.deferrals.proposeInvoice(actor, key(), input),
    rootEntry = await post(actor, root);
  const f = {
    actor,
    company,
    year,
    method,
    vat,
    direction,
    deduction,
    contract,
    invoice,
    root,
    rootEntry,
    input,
    irrecoverable,
  };
  await release(f, '2026-01-01');
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function release(
  f: Pick<Fixture, 'actor' | 'year' | 'method' | 'root'>,
  month: string,
  revision?: { id: string; version: number },
) {
  let benefitEvidence;
  if (f.method === 'evidenced_monthly_amounts') {
    const date = new Date(`${month}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    date.setUTCDate(0);
    const proof = await source(
      f.actor,
      `Completed service confirmation ${month} ${key()}`,
      'acceptance.txt',
    );
    benefitEvidence = { evidenceId: proof.id, evidenceDate: date.toISOString().slice(0, 10) };
  }
  const proposal = await service.deferrals.proposeRelease(
    f.actor,
    key(),
    {
      financialYearId: f.year.id,
      deferralId: f.root.id,
      month,
      ...(benefitEvidence ? { benefitEvidence } : {}),
    },
    revision,
  );
  return { proposal, ...(await post(f.actor, proposal)) };
}
async function reduce(f: Fixture) {
  const agreement = await source(
      f.actor,
      `New agreement cancels unprovided future services ${key()}`,
    ),
    noVatSale = f.vat === 'non_vat' && f.direction === 'sale',
    xml = await source(
      f.actor,
      invoiceXml({
        credit: true,
        number: key(),
        originalNumber: f.invoice.body.number,
        date: '2026-02-01',
        direction: f.direction,
        net: '20.00',
        tax: noVatSale ? '0.00' : '4.20',
        gross: noVatSale ? '20.00' : '24.20',
        ...(noVatSale ? { category: 'O' } : {}),
      }),
      'scope-credit.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: xml.id }),
    proposal = await service.deferrals.proposeScopeReduction(f.actor, key(), {
      financialYearId: f.year.id,
      invoiceId: invoice.id,
      originalInvoiceId: f.invoice.id,
      recognitionDate: '2026-02-01',
      decisionDate: '2026-02-01',
      treatmentEvidenceId: agreement.id,
      kind: 'cancellation',
      periodBasis: 'current_period_event',
      cancelFrom: '2026-02-01',
      changeBasis: 'cancelled_future_services',
      remainingServices:
        f.method === 'evidenced_monthly_amounts' ? 'documented_monthly_benefits' : 'uniform',
      ...(f.method === 'evidenced_monthly_amounts'
        ? { benefits: benefits(f.irrecoverable ? ['48.40', '24.20'] : ['40.00', '20.00'], 1) }
        : {}),
      reason: 'Cancel only future services and preserve the recognized January benefit',
    }),
    entry = await post(f.actor, proposal);
  return { agreement, invoice, proposal, entry };
}
async function amend(f: Fixture, changes: Partial<DeferralRescheduleInput> = {}) {
  const agreement = await source(f.actor, `Separate future calendar agreement ${key()}`),
    input: DeferralRescheduleInput = {
      financialYearId: f.year.id,
      deferralId: f.root.id,
      date: '2026-02-01',
      effectiveFrom: '2026-02-01',
      serviceTo: f.method === 'equal_calendar_months' ? '2026-04-30' : '2026-04-10',
      evidenceId: agreement.id,
      evidenceDate: '2026-02-01',
      method: f.method,
      priceUnchanged: true,
      reason:
        'Reschedule only remaining service benefits without changing billed value, credits or VAT',
      ...(f.method === 'evidenced_monthly_amounts'
        ? {
            benefits: benefits(
              f.irrecoverable ? ['24.20', '24.20', '24.20'] : ['20.00', '20.00', '20.00'],
              1,
            ),
          }
        : {}),
      ...changes,
    },
    review = reviewOutput.parse(
      await service.capabilities.invoke(f.actor, 'deferrals.proposeReschedule', key(), input),
    );
  return { agreement, input, review, effect: deferralRescheduleEffect.parse(review.effect) };
}
async function apply(f: Fixture, review: { id: string; hash: string }, commandKey: string = key()) {
  const input = { id: review.id, hash: review.hash };
  await service.reviews.approve(f.actor, key(), input);
  return service.reviews.execute(f.actor, commandKey, input);
}
async function financialSnapshot(f: Fixture) {
  return {
    journals: await db.orm.select().from(journals).where(eq(journals.companyId, f.company.id)),
    lines: await db.orm.select().from(journalLines).where(eq(journalLines.companyId, f.company.id)),
    position: await service.positions.read(f.actor, {
      invoiceId: f.invoice.id,
      date: '2026-06-30',
    }),
    vat: await service.vat.summary(f.actor, { financialYearId: f.year.id }),
  };
}

describe('future calendars of partially cancelled services', () => {
  for (const method of [
    'equal_calendar_months',
    'actual_calendar_days',
    'evidenced_monthly_amounts',
  ] as const) {
    test.each([
      { vat: 'normal_vat' as const, direction: 'purchase' as const, deduction: 'full' as const },
      { vat: 'normal_vat' as const, direction: 'purchase' as const, deduction: 'none' as const },
      { vat: 'normal_vat' as const, direction: 'sale' as const, deduction: 'none' as const },
      { vat: 'non_vat' as const, direction: 'purchase' as const, deduction: 'none' as const },
      { vat: 'non_vat' as const, direction: 'sale' as const, deduction: 'none' as const },
    ])(
      `${method} $vat $direction $deduction preserves the credit and recognizes only the reduced tail`,
      async (c) => {
        const f = await fixture(method, c.vat, c.direction, c.deduction),
          scope = await reduce(f),
          calendar = await amend(f),
          before = await financialSnapshot(f);
        expect(calendar.effect.scopeCredit).toEqual({
          journalId: scope.entry.id,
          invoiceId: scope.invoice.id,
          financialYearId: f.year.id,
          amount: f.irrecoverable ? '24.20' : '20.00',
        });
        const expected =
          method === 'equal_calendar_months'
            ? f.irrecoverable
              ? ['18.82', '18.82', '18.83']
              : ['15.55', '15.55', '15.57']
            : method === 'actual_calendar_days'
              ? f.irrecoverable
                ? ['25.96', '28.75', '9.28']
                : ['21.46', '23.76', '7.67']
              : f.irrecoverable
                ? ['24.20', '24.20', '24.20']
                : ['20.00', '20.00', '20.00'];
        expect(calendar.effect.afterSchedule.slice(1).map((row) => row.amount)).toEqual(expected);
        await apply(f, calendar.review);
        expect(await financialSnapshot(f)).toEqual(before);
        const state = deferralPositionOutput.parse(
          await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-04-30' }),
        );
        expect(state.schedule.slice(1).map((row) => row.amount)).toEqual(expected);
        expect(state.cancelled).toBe(f.irrecoverable ? '24.20' : '20.00');
        expect(
          (await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-01-31' })).cancelled,
        ).toBe('0.00');
        for (const month of ['2026-02-01', '2026-03-01', '2026-04-01']) await release(f, month);
        expect(
          await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-04-30' }),
        ).toMatchObject({ remaining: '0.00', status: 'allocated' });
        expect(
          await service.deferrals.reconcile(f.actor, {
            financialYearId: f.year.id,
            date: '2026-04-30',
          }),
        ).toMatchObject({ status: 'reconciled' });
        expect((await service.vat.summary(f.actor, { financialYearId: f.year.id })).totals).toEqual(
          before.vat.totals,
        );
      },
    );
  }

  test('same-day pre-credit calendars cannot replace the reduced plan; repeated later calendars can', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      first = await amend(f, { benefits: benefits(['30.00', '25.00', '25.00'], 1) });
    await apply(f, first.review);
    // The current reduced plan follows the already amended calendar.
    const agreement = await source(
        f.actor,
        `Separate scope reduction after first calendar ${key()}`,
      ),
      xml = await source(
        f.actor,
        invoiceXml({
          credit: true,
          number: key(),
          originalNumber: f.invoice.body.number,
          date: '2026-02-01',
          net: '20.00',
          tax: '4.20',
          gross: '24.20',
        }),
        'scope.xml',
      ),
      invoice = await service.invoices.import(f.actor, key(), { evidenceId: xml.id });
    await post(
      f.actor,
      await service.deferrals.proposeScopeReduction(f.actor, key(), {
        financialYearId: f.year.id,
        invoiceId: invoice.id,
        originalInvoiceId: f.invoice.id,
        recognitionDate: '2026-02-01',
        decisionDate: '2026-02-01',
        treatmentEvidenceId: agreement.id,
        kind: 'cancellation',
        periodBasis: 'current_period_event',
        cancelFrom: '2026-02-01',
        changeBasis: 'cancelled_future_services',
        remainingServices: 'documented_monthly_benefits',
        benefits: benefits(['20.00', '20.00', '20.00'], 1),
        reason: 'Cancel future scope under the current calendar, preserve January',
      }),
    );
    expect(
      (await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-01' })).schedule
        .slice(1)
        .map((r) => r.amount),
    ).toEqual(['20.00', '20.00', '20.00']);
    const second = await amend(f, {
      serviceTo: '2026-05-10',
      benefits: benefits(['15.00', '15.00', '15.00', '15.00'], 1),
    });
    await apply(f, second.review);
    await release(f, '2026-02-01');
    const third = await amend(f, {
      date: '2026-03-01',
      evidenceDate: '2026-03-01',
      effectiveFrom: '2026-03-01',
      serviceTo: '2026-04-15',
      benefits: benefits(['25.00', '20.00'], 2),
    });
    await apply(f, third.review);
    expect(third.effect.beforeSchedule[1].amount).toBe('15.00');
    expect(third.effect.afterSchedule.map((r) => r.amount)).toEqual([
      '20.00',
      '15.00',
      '25.00',
      '20.00',
    ]);
    await release(f, '2026-03-01');
    await release(f, '2026-04-01');
    expect(
      (await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-04-30' })).remaining,
    ).toBe('0.00');
  });

  test('a posted scope credit supersedes a prepared older calendar; changed calendars invalidate monthly approvals', async () => {
    const f = await fixture(),
      old = await amend(f);
    await service.reviews.approve(f.actor, key(), { id: old.review.id, hash: old.review.hash });
    await reduce(f);
    await expect(
      service.reviews.execute(f.actor, key(), { id: old.review.id, hash: old.review.hash }),
    ).rejects.toThrow();
    const oldQueue = await service.capabilities.invoke(f.actor, 'reviews.list', key(), {
      status: 'superseded',
    });
    expect(JSON.stringify(oldQueue)).toContain(old.review.id);
    const p = await service.deferrals.proposeRelease(f.actor, key(), {
      financialYearId: f.year.id,
      deferralId: f.root.id,
      month: '2026-02-01',
    });
    await service.books.approve(f.actor, key(), p.id, { version: p.version, hash: p.hash });
    const current = await amend(f),
      competing = await amend(f, { serviceTo: '2026-05-10' });
    await apply(f, current.review);
    await expect(
      service.reviews.approve(f.actor, key(), {
        id: competing.review.id,
        hash: competing.review.hash,
      }),
    ).rejects.toThrow();
    await expect(service.ledger.post(f.actor, key(), exact(p))).rejects.toThrow();
    await release(f, '2026-02-01', { id: p.id, version: p.version });
  });

  test('SQLite rejects forged credit context, restored budgets, changed prefixes and reused evidence', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      scope = await reduce(f),
      calendar = await amend(f),
      january = (
        await db.orm.select().from(journals).where(eq(journals.companyId, f.company.id))
      ).find((row) => row.date === '2026-01-31')!,
      confirmation = (
        await db.orm.select().from(evidence).where(eq(evidence.id, january.evidenceId))
      )[0],
      mutations: Array<(e: DeferralRescheduleEffect) => void> = [
        (e) => {
          Reflect.deleteProperty(e, 'scopeCredit');
        },
        (e) => {
          e.scopeCredit!.journalId = key();
        },
        (e) => {
          e.scopeCredit!.invoiceId = key();
        },
        (e) => {
          e.scopeCredit!.financialYearId = key();
        },
        (e) => {
          e.scopeCredit!.amount = '0.00';
        },
        (e) => {
          e.amount = '80.00';
          e.benefits = benefits(['30.00', '25.00', '25.00'], 1);
          e.afterSchedule.slice(1).forEach((row, i) => {
            row.amount = e.benefits![i].amount;
          });
        },
        (e) => {
          e.afterSchedule[0].amount = '21.00';
          e.afterSchedule[1].amount = '19.00';
        },
        (e) => {
          e.beforeSchedule = generalBodySchema.parse(f.root.body).invoice!.deferral!.schedule;
        },
        (e) => {
          e.date = '2026-01-31';
          e.evidenceDate = '2026-01-31';
        },
        (e) => {
          e.evidenceId = scope.agreement.id;
          e.evidenceHash = scope.agreement.hash;
        },
        (e) => {
          e.evidenceId = confirmation.id;
          e.evidenceHash = confirmation.hash;
        },
      ];
    for (const mutate of mutations) {
      const effect = structuredClone(calendar.effect);
      mutate(effect);
      const id = key(),
        input = Object.fromEntries(
          Object.keys(calendar.input).map((k) => [k, effect[k as keyof DeferralRescheduleEffect]]),
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
            deferralId: f.root.id,
            sequence: effect.sequence,
            date: effect.date,
            evidenceId: effect.evidenceId,
            body: effect,
            createdBy: ownerId,
          })
          .execute(),
      ).rejects.toThrow();
    }
    await apply(f, calendar.review);
  });

  test('new timing evidence cannot be the credit, scope agreement or a posted service confirmation', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      scope = await reduce(f),
      january = (
        await db.orm.select().from(journals).where(eq(journals.companyId, f.company.id))
      ).find((row) => row.date === '2026-01-31')!;
    for (const evidenceId of [scope.agreement.id, scope.invoice.evidenceId, january.evidenceId])
      await expect(amend(f, { evidenceId })).rejects.toMatchObject({
        code: 'DEFERRAL_RESCHEDULE_EVIDENCE',
      });
    await expect(
      amend(f, { date: '2026-01-31', evidenceDate: '2026-01-31' }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_EVENT_ORDER' });
    await expect(
      amend(f, { benefits: benefits(['30.00', '25.00', '25.00'], 1) }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_BENEFIT_AMOUNT' });
    const other = await fixture('evidenced_monthly_amounts');
    await expect(amend(f, { evidenceId: other.contract.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('an added month remains due at close, and a current reduced-plan review must be resolved', async () => {
    const f = await fixture();
    await reduce(f);
    const calendar = await amend(f);
    await apply(f, calendar.review);
    await release(f, '2026-02-01');
    await release(f, '2026-03-01');
    const statement = await source(
      f.actor,
      'movement_id,booking_date,amount,currency,reference\n',
      'statement.csv',
    );
    await service.bank.importStatement(f.actor, key(), {
      evidenceId: statement.id,
      bankAccount: 'RO00REDUCED',
      statementId: key(),
      from: '2026-04-01',
      to: '2026-04-30',
      opening: '1000.00',
      closing: '1000.00',
    });
    await expect(service.periods.close(f.actor, key(), '2026-04-01')).rejects.toMatchObject({
      code: 'DEFERRAL_ALLOCATION_DUE',
    });
    const pending = await amend(f, {
      date: '2026-04-01',
      effectiveFrom: '2026-04-01',
      evidenceDate: '2026-04-01',
      serviceTo: '2026-05-10',
    });
    await expect(service.periods.close(f.actor, key(), '2026-04-01')).rejects.toMatchObject({
      code: 'DEFERRAL_RESCHEDULE_PENDING',
    });
    await service.reviews.reject(f.actor, key(), {
      id: pending.review.id,
      hash: pending.review.hash,
      reason: 'The proposed extension was not agreed; retain the existing service end',
    });
    await release(f, '2026-04-01');
    await service.periods.close(f.actor, key(), '2026-04-01');
  });

  test('reduced calendar history, sources and idempotent outcomes survive export and fresh restore', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      scope = await reduce(f),
      calendar = await amend(f),
      commandKey = key(),
      [a, b] = await Promise.all([
        apply(f, calendar.review, commandKey),
        apply(f, calendar.review, commandKey),
      ]);
    expect(a).toEqual(b);
    await release(f, '2026-02-01');
    const state = await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-28' }),
      job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.deferralReschedules[0].body.scopeCredit.journalId).toBe(scope.entry.id);
    await backup(db, objects, join(directory, 'backup'));
    const restored = await restore(join(directory, 'backup'), join(directory, 'restored')),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-28' })).toEqual(
        state,
      );
      expect(
        await copy.reviews.execute(f.actor, commandKey, {
          id: calendar.review.id,
          hash: calendar.review.hash,
        }),
      ).toEqual(a);
      expect((await copy.documents.read(f.actor, calendar.agreement.id)).bytes).toEqual(
        (await service.documents.read(f.actor, calendar.agreement.id)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(deferralReschedules)
          .where(eq(deferralReschedules.id, calendar.review.id))
          .execute(),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });

  test('MCP retains the posted credit, pauses for human approval and checks revoked cached execution', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      scope = await reduce(f),
      candidate = await amend(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Reduced calendar assistant',
        scopes: ['deferrals.proposeReschedule', 'reviews.execute', 'deferrals.get'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'reduced-calendar-contract', version: '1' },
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
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('reviews.approve');
      const review = reviewOutput.parse(
          (await invoke('deferrals.proposeReschedule', candidate.input)).structuredContent,
        ),
        effect = deferralRescheduleEffect.parse(review.effect),
        input = { id: review.id, hash: review.hash };
      expect(effect.scopeCredit?.journalId).toBe(scope.entry.id);
      expect((await invoke('reviews.execute', input)).isError).toBe(true);
      const before = await financialSnapshot(f);
      await service.reviews.approve(f.actor, key(), input);
      const executeKey = key();
      expect((await invoke('reviews.execute', input, executeKey)).isError).not.toBe(true);
      expect(await financialSnapshot(f)).toEqual(before);
      expect(
        deferralPositionOutput
          .parse(
            (await invoke('deferrals.get', { id: f.root.id, date: '2026-04-30' }))
              .structuredContent,
          )
          .schedule.slice(1)
          .map((row) => row.amount),
      ).toEqual(['20.00', '20.00', '20.00']);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(invoke('reviews.execute', input, executeKey)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test('a new-year calendar retains the prior-year credit and requires the reduced opening control', async () => {
    const company = await service.companies.create(ownerId, key(), {
        name: 'Carried reduced services SRL',
        cui: '12345678',
        year: 2025,
      }),
      actor = { companyId: company.id, actorId: ownerId },
      oldYear = (await service.foundation.years(actor)).find((row) => row.kind === 'financial')!,
      contract = await source(actor, 'Documented future service agreement signed in December 2025');
    for (const input of [
      { axis: 'vat', value: 'normal_vat' },
      { axis: 'vat_collection', value: 'no' },
    ])
      await service.foundation.recordRegime(actor, key(), {
        ...input,
        effectiveFrom: '2025-01-01',
        evidenceId: contract.id,
      });
    await post(
      actor,
      await service.ledger.propose(actor, key(), {
        financialYearId: oldYear.id,
        evidenceId: contract.id,
        date: oldYear.from,
        purpose: 'opening',
        sourceReference: 'opening2025',
        description: 'Documented opening',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
        ],
      }),
    );
    const xml = await source(
        actor,
        invoiceXml({ number: key(), date: '2025-12-01' }),
        'invoice.xml',
      ),
      invoice = await service.invoices.import(actor, key(), { evidenceId: xml.id }),
      root = await service.deferrals.proposeInvoice(actor, key(), {
        financialYearId: oldYear.id,
        invoiceId: invoice.id,
        recognitionDate: '2025-12-01',
        evidenceId: contract.id,
        evidenceDate: '2025-12-01',
        taxPointBasis: 'early_invoice',
        account: '628',
        deduction: 'full',
        counterpartyVatCollection: 'no',
        basis: 'documented_monthly_benefits',
        method: 'evidenced_monthly_amounts',
        benefits: benefits(['20.00', '50.00', '30.00']),
        serviceFrom: '2026-01-01',
        serviceTo: '2026-03-31',
        reason: 'Explicit future benefit amounts agreed before service starts',
      });
    await post(actor, root);
    const agreement = await source(
        actor,
        'Separate December scope reduction of only unprovided future services',
      ),
      creditXml = await source(
        actor,
        invoiceXml({
          credit: true,
          number: key(),
          originalNumber: invoice.body.number,
          date: '2025-12-01',
          net: '20.00',
          tax: '4.20',
          gross: '24.20',
        }),
        'credit.xml',
      ),
      credit = await service.invoices.import(actor, key(), { evidenceId: creditXml.id }),
      p = await service.deferrals.proposeScopeReduction(actor, key(), {
        financialYearId: oldYear.id,
        invoiceId: credit.id,
        originalInvoiceId: invoice.id,
        recognitionDate: '2025-12-01',
        decisionDate: '2025-12-01',
        treatmentEvidenceId: agreement.id,
        kind: 'cancellation',
        periodBasis: 'current_period_event',
        cancelFrom: '2026-01-01',
        changeBasis: 'cancelled_future_services',
        remainingServices: 'documented_monthly_benefits',
        benefits: benefits(['10.00', '40.00', '30.00']),
        reason: 'Cancel unprovided scope before the new year begins',
      }),
      creditEntry = await post(actor, p),
      year = await service.foundation.createYear(actor, key(), {
        kind: 'financial',
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      });
    expect(
      await service.deferrals.reconcile(actor, { financialYearId: year.id, date: '2026-01-01' }),
    ).toMatchObject({
      status: 'needs_review',
      prepaid: { ledger: '0.00', remaining: '80.00', difference: '-80.00' },
    });
    await post(
      actor,
      await service.ledger.propose(actor, key(), {
        financialYearId: year.id,
        evidenceId: contract.id,
        date: year.from,
        purpose: 'opening',
        sourceReference: 'opening2026',
        description: 'Independently supplied reduced control carry',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '471', debit: '80.00', credit: '0.00' },
          { account: '4426', debit: '16.80', credit: '0.00' },
          { account: '401', debit: '0.00', credit: '96.80' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
        ],
      }),
    );
    const timing = await source(
        actor,
        'New January timing agreement preserves the December credit and billed value',
      ),
      review = reviewOutput.parse(
        await service.capabilities.invoke(actor, 'deferrals.proposeReschedule', key(), {
          financialYearId: year.id,
          deferralId: root.id,
          date: '2026-01-01',
          effectiveFrom: '2026-01-01',
          serviceTo: '2026-04-15',
          evidenceId: timing.id,
          evidenceDate: '2026-01-01',
          method: 'evidenced_monthly_amounts',
          benefits: benefits(['20.00', '20.00', '20.00', '20.00']),
          priceUnchanged: true,
          reason: 'Document only a new calendar for the reduced future value',
        }),
      ),
      effect = deferralRescheduleEffect.parse(review.effect),
      input = { id: review.id, hash: review.hash };
    expect(effect.scopeCredit).toMatchObject({
      journalId: creditEntry.id,
      financialYearId: oldYear.id,
      amount: '20.00',
    });
    expect((await service.overview(actor, year.id)).invoiceLabels[credit.id]?.number).toBe(
      credit.body.number,
    );
    await service.reviews.approve(actor, key(), input);
    await service.reviews.execute(actor, key(), input);
    for (const month of ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'])
      await release({ actor, year, root, method: 'evidenced_monthly_amounts' }, month);
    expect(
      await service.deferrals.reconcile(actor, { financialYearId: year.id, date: '2026-04-30' }),
    ).toMatchObject({ status: 'reconciled' });
    expect(await service.vat.summary(actor, { financialYearId: year.id })).toMatchObject({
      totals: { inputTax: '0.00', outputTax: '0.00' },
    });
  });
});
