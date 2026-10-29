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
  type GeneralBody,
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
  approvals,
  proposals,
  facts,
  deferralCancellations,
  actionReviews,
  deferralReschedules,
  journals,
  journalLines,
  evidence,
} from '../../source/accounting/schema';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { postJournal } from '../../source/accounting/ledger';
import { invoiceXml } from './fixtures/invoice';

const key = () => randomUUID(),
  secret = 'synthetic-sequential-credit-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-sequential-credits-'));
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
        email: 'sequential-credits@example.test',
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

async function nextCredit(
  f: Fixture,
  options: {
    net?: string;
    tax?: string;
    gross?: string;
    date?: string;
    cancelFrom?: string;
    amounts?: string[];
    full?: boolean;
    evidenceId?: string;
  } = {},
) {
  const noVatSale = f.vat === 'non_vat' && f.direction === 'sale',
    agreement = await source(f.actor, `Separate further scope agreement ${key()}`),
    date = options.date ?? '2026-02-01',
    xml = await source(
      f.actor,
      invoiceXml({
        credit: true,
        number: key(),
        originalNumber: f.invoice.body.number,
        date,
        direction: f.direction,
        net: options.net ?? '10.00',
        tax: options.tax ?? (noVatSale ? '0.00' : '2.10'),
        gross: options.gross ?? (noVatSale ? '10.00' : '12.10'),
        ...(noVatSale ? { category: 'O' } : {}),
      }),
      'further-credit.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: xml.id }),
    input = {
      financialYearId: f.year.id,
      invoiceId: invoice.id,
      originalInvoiceId: f.invoice.id,
      recognitionDate: date,
      decisionDate: date,
      treatmentEvidenceId: options.evidenceId ?? agreement.id,
      kind: 'cancellation' as const,
      periodBasis: 'current_period_event' as const,
      cancelFrom: options.cancelFrom ?? '2026-02-01',
      reason: 'Cancel further unprovided services against the current reduced balance',
    };
  const scopeInput = {
    ...input,
    changeBasis: 'cancelled_future_services' as const,
    remainingServices:
      f.method === 'evidenced_monthly_amounts'
        ? ('documented_monthly_benefits' as const)
        : ('uniform' as const),
    ...(f.method === 'evidenced_monthly_amounts'
      ? {
          benefits: benefits(
            options.amounts ?? (f.irrecoverable ? ['36.30', '24.20'] : ['30.00', '20.00']),
            Number(input.cancelFrom.slice(5, 7)) - 1,
          ),
        }
      : {}),
  };
  return {
    agreement,
    invoice,
    input,
    scopeInput,
    prepare: () =>
      options.full
        ? service.deferrals.proposeCreditNote(f.actor, key(), input)
        : service.deferrals.proposeScopeReduction(f.actor, key(), scopeInput),
  };
}
async function rawPost(f: Fixture, template: GeneralBody, mutate: (body: GeneralBody) => void) {
  const body = structuredClone(template);
  mutate(body);
  const id = key(),
    factId = key(),
    approvalId = key(),
    hash = sha256(canonical(body));
  await db.write(async (tx) => {
    await tx.insert(facts).values({
      id: factId,
      companyId: f.company.id,
      kind: 'general',
      evidenceId: body.evidenceId,
      body,
      createdBy: ownerId,
    });
    await tx.insert(proposals).values({
      id,
      companyId: f.company.id,
      factId,
      kind: 'general',
      version: 1,
      body,
      hash,
      sourceKey: key(),
      createdBy: ownerId,
    });
    await tx.insert(approvals).values({
      id: approvalId,
      companyId: f.company.id,
      proposalId: id,
      version: 1,
      hash,
      createdBy: ownerId,
    });
  });
  return db.write((tx) =>
    postJournal(tx, f.actor, {
      date: body.date,
      kind: 'general',
      sourceId: id,
      evidenceId: body.evidenceId,
      approvalId,
      description: body.description,
      lines: body.lines,
    }),
  );
}

describe('successive credit-backed service cancellations', () => {
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
      `${method}: $vat $direction $deduction preserves all credits and the current reduced plan`,
      async (c) => {
        const f = await fixture(method, c.vat, c.direction, c.deduction),
          first = await reduce(f),
          draft = await nextCredit(f),
          second = await draft.prepare(),
          body = generalBodySchema.parse(second.body),
          plan = body.invoice!.deferralCredit!;
        expect(plan.priorCancellation).toEqual({
          journalId: first.entry.id,
          invoiceId: first.invoice.id,
          financialYearId: f.year.id,
          count: 1,
          amount: f.irrecoverable ? '24.20' : '20.00',
        });
        expect(plan.remainingBefore).toBe(
          method === 'equal_calendar_months'
            ? f.irrecoverable
              ? '56.47'
              : '46.67'
            : method === 'actual_calendar_days'
              ? f.irrecoverable
                ? '63.99'
                : '52.89'
              : f.irrecoverable
                ? '72.60'
                : '60.00',
        );
        const expected =
          method === 'equal_calendar_months'
            ? f.irrecoverable
              ? ['40.33', '22.18', '22.19']
              : ['33.33', '18.33', '18.34']
            : method === 'actual_calendar_days'
              ? f.irrecoverable
                ? ['32.81', '33.78', '18.11']
                : ['27.11', '27.92', '14.97']
              : f.irrecoverable
                ? ['24.20', '36.30', '24.20']
                : ['20.00', '30.00', '20.00'];
        if (plan.schemaVersion === 1) throw Error('partial reduction required');
        expect(plan.afterSchedule.map((row) => row.amount)).toEqual(expected);
        const commandKey = key(),
          entry = await post(f.actor, second, commandKey);
        expect(await service.ledger.post(f.actor, commandKey, exact(second))).toEqual(entry);
        const position = deferralPositionOutput.parse(
          await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-01' }),
        );
        expect(position.cancelled).toBe(f.irrecoverable ? '36.30' : '30.00');
        expect(
          position.cancellations?.map((row) => [row.sequence, row.journalId, row.amount]),
        ).toEqual([
          [1, first.entry.id, f.irrecoverable ? '24.20' : '20.00'],
          [2, entry.id, f.irrecoverable ? '12.10' : '10.00'],
        ]);
        expect(position.schedule.map((row) => row.amount)).toEqual(expected);
        expect(
          (await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-01-31' })).cancelled,
        ).toBe('0.00');
        expect(
          (await db.orm.select().from(proposals).where(eq(proposals.id, f.root.id)))[0].hash,
        ).toBe(f.root.hash);
        expect(
          (await db.orm.select().from(proposals).where(eq(proposals.id, first.proposal.id)))[0]
            .hash,
        ).toBe(first.proposal.hash);
        const calendar = await amend(f, {
          ...(method === 'evidenced_monthly_amounts'
            ? {
                benefits: benefits(
                  f.irrecoverable ? ['24.20', '24.20', '12.10'] : ['20.00', '20.00', '10.00'],
                  1,
                ),
              }
            : {}),
        });
        expect(calendar.effect.scopeCredit).toMatchObject({
          journalId: entry.id,
          invoiceId: draft.invoice.id,
          priorAmount: f.irrecoverable ? '24.20' : '20.00',
          priorCount: 1,
        });
        const snapshot = await financialSnapshot(f);
        await apply(f, calendar.review);
        expect(await financialSnapshot(f)).toEqual(snapshot);
        for (const month of ['2026-02-01', '2026-03-01', '2026-04-01']) await release(f, month);
        expect(
          await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-04-30' }),
        ).toMatchObject({
          cancelled: f.irrecoverable ? '36.30' : '30.00',
          allocated: f.irrecoverable ? '84.70' : '70.00',
          remaining: '0.00',
          status: 'allocated',
        });
        expect(
          await service.deferrals.reconcile(f.actor, {
            financialYearId: f.year.id,
            date: '2026-04-30',
          }),
        ).toMatchObject({ status: 'reconciled' });
        const vat = await service.vat.summary(f.actor, { financialYearId: f.year.id });
        expect(vat.status).toBe('reconciled');
        expect(vat.totals.inputTax).toBe(
          c.direction === 'purchase' && c.vat === 'normal_vat' && c.deduction === 'full'
            ? '14.70'
            : '0.00',
        );
        expect(vat.totals.outputTax).toBe(
          c.direction === 'sale' && c.vat === 'normal_vat' ? '14.70' : '0.00',
        );
      },
    );
  }
  test.each([
    'equal_calendar_months',
    'actual_calendar_days',
    'evidenced_monthly_amounts',
  ] as const)(
    '%s: a final cancellation retains the reduced earlier month and blocks further scope changes',
    async (method) => {
      const f = await fixture(method);
      await reduce(f);
      const end =
          method === 'equal_calendar_months'
            ? { net: '23.34', tax: '4.90', gross: '28.24' }
            : method === 'actual_calendar_days'
              ? { net: '18.45', tax: '3.87', gross: '22.32' }
              : { net: '20.00', tax: '4.20', gross: '24.20' },
        final = await nextCredit(f, { ...end, cancelFrom: '2026-03-01', full: true }),
        p = await final.prepare();
      expect(generalBodySchema.parse(p.body).invoice!.deferralCredit).toMatchObject({
        schemaVersion: 1,
        priorCancellation: { count: 1, amount: '20.00' },
      });
      await post(f.actor, p);
      const feb = await release(f, '2026-02-01');
      expect(generalBodySchema.parse(feb.proposal.body).deferralRelease!.amount).toBe(
        method === 'equal_calendar_months'
          ? '23.33'
          : method === 'actual_calendar_days'
            ? '34.44'
            : '40.00',
      );
      expect(
        await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-03-31' }),
      ).toMatchObject({ remaining: '0.00', status: 'cancelled' });
      expect(
        await service.deferrals.reconcile(f.actor, {
          financialYearId: f.year.id,
          date: '2026-03-31',
        }),
      ).toMatchObject({ status: 'reconciled' });
      await expect(
        service.deferrals.proposeRelease(f.actor, key(), {
          financialYearId: f.year.id,
          deferralId: f.root.id,
          month: '2026-03-01',
        }),
      ).rejects.toMatchObject({ code: 'DEFERRAL_MONTH_CANCELLED' });
      const further = await nextCredit(f);
      await expect(further.prepare()).rejects.toMatchObject({ code: 'DEFERRAL_ALREADY_CANCELLED' });
      await expect(amend(f)).rejects.toMatchObject({ code: 'DEFERRAL_ALREADY_CANCELLED' });
    },
  );
  test('a third credit uses the latest timing review and cannot restore either earlier reduction', async () => {
    const f = await fixture('evidenced_monthly_amounts');
    const first = await reduce(f),
      secondDraft = await nextCredit(f),
      second = await secondDraft.prepare();
    const secondEntry = await post(f.actor, second);
    const calendar = await amend(f, { benefits: benefits(['15.00', '20.00', '15.00'], 1) });
    await apply(f, calendar.review);
    const thirdDraft = await nextCredit(f, {
        net: '5.00',
        tax: '1.05',
        gross: '6.05',
        amounts: ['10.00', '20.00', '15.00'],
      }),
      third = await thirdDraft.prepare(),
      plan = generalBodySchema.parse(third.body).invoice!.deferralCredit!;
    expect(plan.priorCancellation).toMatchObject({
      journalId: secondEntry.id,
      count: 2,
      amount: '30.00',
    });
    expect(plan).toMatchObject({ remainingBefore: '50.00', remainingAfter: '45.00' });
    await post(f.actor, third);
    const current = deferralPositionOutput.parse(
      await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-04-30' }),
    );
    expect(current.schedule.map((row) => row.amount)).toEqual(['20.00', '10.00', '20.00', '15.00']);
    expect(current.cancellations?.map((row) => row.sequence)).toEqual([1, 2, 3]);
    for (const month of ['2026-02-01', '2026-03-01', '2026-04-01']) await release(f, month);
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.year.id,
        date: '2026-04-30',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });
});

describe('successive credit protection and continuity', () => {
  test('competing credit approvals and pending calendars become stale against a newly posted credit', async () => {
    const f = await fixture();
    await reduce(f);
    const old = await amend(f),
      a = await nextCredit(f),
      b = await nextCredit(f),
      pa = await a.prepare(),
      pb = await b.prepare(),
      monthly = await service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.year.id,
        deferralId: f.root.id,
        month: '2026-02-01',
      });
    await service.reviews.approve(f.actor, key(), { id: old.review.id, hash: old.review.hash });
    for (const p of [pa, pb, monthly])
      await service.books.approve(f.actor, key(), p.id, { version: p.version, hash: p.hash });
    await service.ledger.post(f.actor, key(), exact(pa));
    await expect(service.ledger.post(f.actor, key(), exact(pb))).rejects.toThrow();
    await expect(service.ledger.post(f.actor, key(), exact(monthly))).rejects.toThrow();
    await expect(
      service.reviews.execute(f.actor, key(), { id: old.review.id, hash: old.review.hash }),
    ).rejects.toThrow();
    expect(
      JSON.stringify(
        await service.capabilities.invoke(f.actor, 'reviews.list', key(), { status: 'superseded' }),
      ),
    ).toContain(old.review.id);
    expect(
      (await service.overview(f.actor)).proposals.find((p) => p.id === monthly.id)?.superseded,
    ).toBe(true);
    const revised = await service.deferrals.proposeScopeReduction(f.actor, key(), b.scopeInput, {
      id: pb.id,
      version: pb.version,
    });
    expect(
      generalBodySchema.parse(revised.body).invoice!.deferralCredit!.priorCancellation,
    ).toMatchObject({ count: 2, amount: '30.00' });
    await expect(service.ledger.post(f.actor, key(), exact(revised))).rejects.toThrow();
    await post(f.actor, revised);
    const current = await service.deferrals.proposeRelease(
      f.actor,
      key(),
      { financialYearId: f.year.id, deferralId: f.root.id, month: '2026-02-01' },
      { id: monthly.id, version: monthly.version },
    );
    expect(
      (await service.overview(f.actor)).proposals.find((p) => p.id === current.id)?.superseded,
    ).toBe(false);
    await post(f.actor, current);
    await release(f, '2026-03-01');
    expect(
      await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-03-31' }),
    ).toMatchObject({ cancelled: '40.00', remaining: '0.00' });
  });
  test('dated views use the cumulative credits known on that date and preserve an already recognized reduced month', async () => {
    const f = await fixture('evidenced_monthly_amounts');
    await reduce(f);
    await release(f, '2026-02-01');
    const d = await nextCredit(f, {
        date: '2026-03-01',
        cancelFrom: '2026-03-01',
        amounts: ['10.00'],
      }),
      p = await d.prepare();
    expect(generalBodySchema.parse(p.body).invoice!.deferralCredit).toMatchObject({
      allocated: '60.00',
      remainingBefore: '20.00',
      remainingAfter: '10.00',
    });
    await post(f.actor, p);
    expect(
      await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-28' }),
    ).toMatchObject({ allocated: '60.00', cancelled: '20.00', remaining: '20.00' });
    expect(
      await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-03-01' }),
    ).toMatchObject({ allocated: '60.00', cancelled: '30.00', remaining: '10.00' });
    await release(f, '2026-03-01');
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.year.id,
        date: '2026-03-31',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });
  test('SQLite independently rejects forged previous credits, cumulative budgets, prefixes and reused agreement bytes', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      first = await reduce(f),
      d = await nextCredit(f),
      p = await d.prepare(),
      base = generalBodySchema.parse(p.body);
    const mutations: Array<(b: GeneralBody) => void> = [
      (b) => {
        Reflect.deleteProperty(b.invoice!.deferralCredit!, 'priorCancellation');
      },
      (b) => {
        b.invoice!.deferralCredit!.priorCancellation!.journalId = key();
      },
      (b) => {
        b.invoice!.deferralCredit!.priorCancellation!.invoiceId = key();
      },
      (b) => {
        b.invoice!.deferralCredit!.priorCancellation!.financialYearId = key();
      },
      (b) => {
        b.invoice!.deferralCredit!.priorCancellation!.amount = '0.00';
      },
      (b) => {
        b.invoice!.deferralCredit!.priorCancellation!.count = 2;
      },
      (b) => {
        b.invoice!.deferralCredit!.remainingBefore = '80.00';
        b.invoice!.deferralCredit!.remainingAfter = '70.00';
      },
      (b) => {
        const c = b.invoice!.deferralCredit!;
        if (c.schemaVersion !== 1) {
          c.afterSchedule[1].amount = '50.00';
        }
      },
      (b) => {
        const c = b.invoice!.deferralCredit!;
        if (c.schemaVersion !== 1) {
          c.beforeSchedule[1].amount = '50.00';
          c.afterSchedule[1].amount = '40.00';
        }
      },
      (b) => {
        const c = b.invoice!.deferralCredit!;
        if (c.schemaVersion !== 1) {
          c.afterSchedule[0].amount = '21.00';
          c.afterSchedule[1].amount = '29.00';
        }
      },
      (b) => {
        b.invoice!.treatmentEvidenceId = first.agreement.id;
        b.invoice!.deferralCredit!.evidenceHash = first.agreement.hash;
      },
    ];
    for (const mutation of mutations)
      await expect(
        rawPost(f, base, mutation).catch((error) => {
          throw error.cause ?? error;
        }),
      ).rejects.toThrow('invalid_or_stale_deferral_cancellation');
    expect(
      (
        await db.orm
          .select()
          .from(deferralCancellations)
          .where(eq(deferralCancellations.companyId, f.company.id))
      ).length,
    ).toBe(1);
    await post(f.actor, p);
    await expect(
      db.orm
        .update(deferralCancellations)
        .set({ sequence: 3 })
        .where(eq(deferralCancellations.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .delete(deferralCancellations)
        .where(eq(deferralCancellations.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
  });
  test('a later calendar must retain every credit in its budget and cannot use an earlier agreement as service proof', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      first = await reduce(f),
      d = await nextCredit(f),
      second = await d.prepare();
    await post(f.actor, second);
    for (const evidenceId of [
      first.agreement.id,
      first.invoice.evidenceId,
      d.agreement.id,
      d.invoice.evidenceId,
    ]) {
      await expect(
        amend(f, { evidenceId, benefits: benefits(['20.00', '20.00', '10.00'], 1) }),
      ).rejects.toMatchObject({ code: 'DEFERRAL_RESCHEDULE_EVIDENCE' });
      await expect(
        service.deferrals.proposeRelease(f.actor, key(), {
          financialYearId: f.year.id,
          deferralId: f.root.id,
          month: '2026-02-01',
          benefitEvidence: { evidenceId, evidenceDate: '2026-02-28' },
        }),
      ).rejects.toMatchObject({ code: 'DEFERRAL_BENEFIT_EVIDENCE' });
      const third = await nextCredit(f, {
        net: '5.00',
        tax: '1.05',
        gross: '6.05',
        amounts: ['25.00', '20.00'],
        evidenceId,
      });
      await expect(third.prepare()).rejects.toMatchObject({
        code: 'DEFERRAL_CANCELLATION_EVIDENCE',
      });
    }
    const calendar = await amend(f, { benefits: benefits(['20.00', '20.00', '10.00'], 1) });
    for (const mutate of [
      (e: DeferralRescheduleEffect) => {
        Reflect.deleteProperty(e.scopeCredit!, 'priorAmount');
      },
      (e: DeferralRescheduleEffect) => {
        e.scopeCredit!.priorAmount = '0.00';
      },
      (e: DeferralRescheduleEffect) => {
        e.scopeCredit!.priorCount = 2;
      },
      (e: DeferralRescheduleEffect) => {
        e.scopeCredit!.journalId = first.entry.id;
      },
      (e: DeferralRescheduleEffect) => {
        e.amount = '70.00';
        e.afterSchedule[1].amount = '40.00';
      },
    ]) {
      const effect = structuredClone(calendar.effect);
      mutate(effect);
      const id = key();
      await db.orm.insert(actionReviews).values({
        id,
        companyId: f.company.id,
        operation: 'deferrals.reschedule',
        input: calendar.input,
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
  test('a second credit cannot exceed the effective future value or use another company evidence', async () => {
    const f = await fixture(),
      other = await fixture();
    await reduce(f);
    const tooLarge = await nextCredit(f, { net: '60.00', tax: '12.60', gross: '72.60' });
    await expect(tooLarge.prepare()).rejects.toMatchObject({ code: 'DEFERRAL_CREDIT_AMOUNT' });
    const unrelated = await nextCredit(f, { evidenceId: other.contract.id });
    await expect(unrelated.prepare()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const valid = await nextCredit(f),
      p = await valid.prepare();
    await post(f.actor, p);
    const backdated = await nextCredit(f, { date: '2026-01-31', cancelFrom: '2026-02-01' });
    await expect(backdated.prepare()).rejects.toMatchObject({ code: 'DEFERRAL_EVENT_ORDER' });
  });
  test('a commercial discount after two scope credits keeps the reduced service plan and original VAT', async () => {
    const f = await fixture(),
      first = await reduce(f),
      d = await nextCredit(f);
    await post(f.actor, await d.prepare());
    const before = await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-01' }),
      discount = await nextCredit(f, { net: '5.00', tax: '1.05', gross: '6.05' }),
      { cancelFrom: _cancelFrom, ...discountInput } = discount.input,
      p = await service.deferrals.proposeDiscount(f.actor, key(), {
        ...discountInput,
        kind: 'commercial_discount',
        servicesUnchanged: true,
      });
    await post(f.actor, p);
    const after = await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-01' });
    expect(after.schedule).toEqual(before.schedule);
    expect(after.cancelled).toBe('30.00');
    expect(generalBodySchema.parse(p.body).lines.find((row) => row.account === '609')?.credit).toBe(
      '5.00',
    );
    for (const month of ['2026-02-01', '2026-03-01']) await release(f, month);
    expect(
      (await service.vat.summary(f.actor, { financialYearId: f.year.id })).totals.inputTax,
    ).toBe('13.65');
  });
  test('successive credits and the resulting calendar survive original-source export, backup and fresh restore', async () => {
    const f = await fixture('evidenced_monthly_amounts'),
      first = await reduce(f),
      d = await nextCredit(f),
      p = await d.prepare(),
      commandKey = key(),
      entry = await post(f.actor, p, commandKey),
      calendar = await amend(f, { benefits: benefits(['20.00', '20.00', '10.00'], 1) });
    await apply(f, calendar.review);
    await release(f, '2026-02-01');
    const state = await service.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-28' }),
      job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(
      exported.deferralCancellations.map((row: { sequence: number }) => row.sequence).sort(),
    ).toEqual([1, 2]);
    await backup(db, objects, join(directory, 'chain-backup'));
    const restored = await restore(
        join(directory, 'chain-backup'),
        join(directory, 'chain-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.deferrals.get(f.actor, { id: f.root.id, date: '2026-02-28' })).toEqual(
        state,
      );
      expect(await copy.ledger.post(f.actor, commandKey, exact(p))).toEqual(entry);
      for (const evidenceId of [
        first.invoice.evidenceId,
        first.agreement.id,
        d.invoice.evidenceId,
        d.agreement.id,
        calendar.agreement.id,
      ])
        expect((await copy.documents.read(f.actor, evidenceId)).bytes).toEqual(
          (await service.documents.read(f.actor, evidenceId)).bytes,
        );
    } finally {
      await copyDb.close();
    }
  });
  test('MCP prepares a second financial credit, requires a human approval and checks revoked cached posting', async () => {
    const f = await fixture('evidenced_monthly_amounts');
    await reduce(f);
    const d = await nextCredit(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Further service credit agent',
        scopes: ['deferrals.proposeScopeReduction', 'ledger.post', 'deferrals.get'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'sequential-credit-contract', version: '1' },
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
      const p = proposalOutput.parse(
          (await invoke('deferrals.proposeScopeReduction', d.scopeInput)).structuredContent,
        ),
        body = generalBodySchema.parse(p.body);
      expect(body.invoice!.deferralCredit!.priorCancellation).toMatchObject({
        count: 1,
        amount: '20.00',
      });
      expect((await invoke('ledger.post', exact(p))).isError).toBe(true);
      await service.books.approve(f.actor, key(), p.id, { version: p.version, hash: p.hash });
      const executionKey = key();
      expect((await invoke('ledger.post', exact(p), executionKey)).isError).not.toBe(true);
      expect(
        deferralPositionOutput.parse(
          (await invoke('deferrals.get', { id: f.root.id, date: '2026-02-01' })).structuredContent,
        ).cancellations?.length,
      ).toBe(2);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(invoke('ledger.post', exact(p), executionKey)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

describe('successive credit financial-year continuity', () => {
  test('a further new-year financial credit preserves prior-year VAT and requires the reduced opening control', async () => {
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
    const secondAgreement = await source(
        actor,
        'Separate further reduction agreed in the new financial year',
      ),
      secondXml = await source(
        actor,
        invoiceXml({
          credit: true,
          number: key(),
          originalNumber: invoice.body.number,
          date: '2026-01-01',
          net: '10.00',
          tax: '2.10',
          gross: '12.10',
        }),
        'second-credit.xml',
      ),
      secondInvoice = await service.invoices.import(actor, key(), { evidenceId: secondXml.id }),
      secondProposal = await service.deferrals.proposeScopeReduction(actor, key(), {
        financialYearId: year.id,
        invoiceId: secondInvoice.id,
        originalInvoiceId: invoice.id,
        recognitionDate: '2026-01-01',
        decisionDate: '2026-01-01',
        treatmentEvidenceId: secondAgreement.id,
        kind: 'cancellation',
        periodBasis: 'current_period_event',
        cancelFrom: '2026-01-01',
        changeBasis: 'cancelled_future_services',
        remainingServices: 'documented_monthly_benefits',
        benefits: benefits(['10.00', '30.00', '30.00']),
        reason:
          'Cancel only unprovided new-year services while retaining the earlier financial-year credit',
      });
    expect(
      generalBodySchema.parse(secondProposal.body).invoice!.deferralCredit!.priorCancellation,
    ).toMatchObject({
      journalId: creditEntry.id,
      financialYearId: oldYear.id,
      amount: '20.00',
      count: 1,
    });
    const secondEntry = await post(actor, secondProposal);
    expect((await service.overview(actor, year.id)).invoiceLabels[credit.id]?.number).toBe(
      credit.body.number,
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
          benefits: benefits(['10.00', '20.00', '20.00', '20.00']),
          priceUnchanged: true,
          reason: 'Document only a new calendar for the reduced future value',
        }),
      ),
      effect = deferralRescheduleEffect.parse(review.effect),
      input = { id: review.id, hash: review.hash };
    expect(effect.scopeCredit).toMatchObject({
      journalId: secondEntry.id,
      financialYearId: year.id,
      amount: '10.00',
      priorAmount: '20.00',
      priorCount: 1,
    });
    expect((await service.overview(actor, year.id)).invoiceLabels[credit.id]?.number).toBe(
      credit.body.number,
    );
    expect(await service.deferrals.get(actor, { id: root.id, date: '2026-01-01' })).toMatchObject({
      cancelled: '30.00',
      remaining: '70.00',
    });
    expect(
      (await service.vat.summary(actor, { financialYearId: oldYear.id })).totals.inputTax,
    ).toBe('16.80');
    await service.reviews.approve(actor, key(), input);
    await service.reviews.execute(actor, key(), input);
    for (const month of ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'])
      await release({ actor, year, root, method: 'evidenced_monthly_amounts' }, month);
    expect(
      await service.deferrals.reconcile(actor, { financialYearId: year.id, date: '2026-04-30' }),
    ).toMatchObject({ status: 'reconciled' });
    expect(await service.vat.summary(actor, { financialYearId: year.id })).toMatchObject({
      totals: { inputTax: '-2.10', outputTax: '0.00' },
    });
  });
});
