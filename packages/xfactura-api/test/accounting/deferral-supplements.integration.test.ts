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
  type DeferralSupplementInput,
  type DeferralScopeReductionInput,
  type DeferralRescheduleInput,
  type GeneralBody,
} from '../../source/accounting/domain';
import {
  facts,
  proposals,
  deferralPostings,
  deferralSupplements,
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
  secret = 'synthetic-supplement-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-supplements-'));
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
        email: 'supplements@example.test',
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

async function supplement(
  f: Fixture,
  parent: Root,
  xml: XmlInput = {},
  change: Partial<DeferralSupplementInput> = {},
  raw?: (xml: string) => string,
) {
  const noVatSale = f.vat === 'non_vat' && parent.invoice.direction === 'sale';
  const proof = await source(
    f.actor,
    `Separate signed agreement for additional future services ${key()}`,
  );
  const text = invoiceXml({
    number: key(),
    date: '2026-02-01',
    direction: parent.invoice.direction,
    net: '30.00',
    tax: noVatSale ? '0.00' : '6.30',
    gross: noVatSale ? '30.00' : '36.30',
    ...(noVatSale ? { category: 'O' } : {}),
    ...xml,
  });
  const file = await source(f.actor, raw ? raw(text) : text, 'supplement.xml');
  const invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  const input: DeferralSupplementInput = {
    ...parent.input,
    invoiceId: invoice.id,
    recognitionDate: invoice.body.issueDate,
    evidenceId: proof.id,
    evidenceDate: invoice.body.issueDate,
    serviceFrom: '2026-02-01',
    serviceTo: '2026-03-15',
    basis: 'uniform_service',
    method: 'actual_calendar_days',
    parentDeferralId: parent.proposal.id,
    changeBasis: 'additional_future_services',
    reason:
      'Separately invoiced additional future services, with independent uniform benefit and original services unchanged',
    ...change,
  };
  return {
    proposal: await service.deferrals.proposeSupplement(f.actor, key(), input),
    input,
    invoice,
    proof,
  };
}

describe('separately invoiced future-service supplements', () => {
  const scenarios = [
    { vat: 'normal_vat', direction: 'purchase', deduction: 'full', grossCost: false },
    { vat: 'non_vat', direction: 'purchase', deduction: 'none', grossCost: true },
    { vat: 'normal_vat', direction: 'sale', deduction: 'none', grossCost: false },
    { vat: 'non_vat', direction: 'sale', deduction: 'none', grossCost: false },
    { vat: 'normal_vat', direction: 'purchase', deduction: 'none', grossCost: true },
  ] as const;
  for (const method of ['equal_calendar_months', 'actual_calendar_days'] as const) {
    test.each(scenarios)(
      `${method}: $vat $direction $deduction keeps each invoice, schedule and VAT movement separate`,
      async (s) => {
        const f = await fixture(s.vat),
          parent = await prepare(
            f,
            {
              direction: s.direction,
              ...(s.vat === 'non_vat' && s.direction === 'sale'
                ? { category: 'O', tax: '0.00', gross: '100.00' }
                : {}),
            },
            { deduction: s.deduction },
          );
        await post(f.actor, parent.proposal);
        await release(f, parent, '2026-01-01');
        await statement(f);
        await service.periods.close(f.actor, key(), '2026-01-01');
        const before = await service.deferrals.get(f.actor, {
          id: parent.proposal.id,
          date: '2026-03-31',
        });
        const added = await supplement(
          f,
          parent,
          {},
          {
            method,
            basis: method === 'actual_calendar_days' ? 'uniform_service' : 'uniform_subscription',
            serviceTo: method === 'actual_calendar_days' ? '2026-03-15' : '2026-03-31',
          },
        );
        const body = generalBodySchema.parse(added.proposal.body),
          plan = body.invoice!.deferral!;
        proposalOutput.parse(added.proposal);
        expect(plan.supplement).toMatchObject({
          parentDeferralId: parent.proposal.id,
          parentInvoiceId: parent.invoice.id,
          parentProposalHash: parent.proposal.hash,
        });
        expect(plan.schedule.map((row) => row.amount)).toEqual(
          method === 'equal_calendar_months'
            ? s.grossCost
              ? ['18.15', '18.15']
              : ['15.00', '15.00']
            : s.grossCost
              ? ['23.63', '12.67']
              : ['19.53', '10.47'],
        );
        await expect(
          service.ledger.post(f.actor, key(), exact(added.proposal)),
        ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
        await post(f.actor, added.proposal);
        expect(
          await service.deferrals.get(f.actor, { id: parent.proposal.id, date: '2026-03-31' }),
        ).toEqual(before);
        const addedState = deferralPositionOutput.parse(
          await service.deferrals.get(f.actor, { id: added.proposal.id, date: '2026-02-01' }),
        );
        expect(addedState).toMatchObject({
          amount: s.grossCost ? '36.30' : '30.00',
          allocated: '0.00',
          supplement: { parentDeferralId: parent.proposal.id },
        });
        const oldPage = await service.deferrals.list(f.actor, {
          date: '2026-01-31',
          parentDeferralId: parent.proposal.id,
          onlyOpen: false,
        });
        expect(oldPage.items).toHaveLength(0);
        expect(
          (
            await service.deferrals.list(f.actor, {
              date: '2026-02-01',
              parentDeferralId: parent.proposal.id,
            })
          ).items.map((row) => row.id),
        ).toEqual([added.proposal.id]);
        for (const month of ['2026-02-01', '2026-03-01']) {
          await release(f, parent, month);
          await release(f, added, month);
        }
        const ledger = await balance(f);
        expect(ledger[s.direction === 'purchase' ? '471' : '472']).toBe('0.00');
        expect(ledger[s.direction === 'purchase' ? '628' : '704']).toBe(
          s.direction === 'sale' ? '-130.00' : s.grossCost ? '157.30' : '130.00',
        );
        expect(
          await service.deferrals.reconcile(f.actor, {
            financialYearId: f.financialYear.id,
            date: '2026-03-31',
          }),
        ).toMatchObject({ status: 'reconciled' });
        expect(
          (
            await service.deferrals.list(f.actor, {
              date: '2026-03-31',
              parentDeferralId: parent.proposal.id,
            })
          ).items,
        ).toHaveLength(0);
        const vat = await service.vat.summary(f.actor, { financialYearId: f.financialYear.id });
        expect(vat).toMatchObject({
          status: 'reconciled',
          entryCount: 2,
          totals: {
            inputTax: s.direction === 'purchase' && s.deduction === 'full' ? '27.30' : '0.00',
            outputTax: s.direction === 'sale' && s.vat === 'normal_vat' ? '27.30' : '0.00',
          },
        });
        await expect(
          service.deferrals.proposeSupplement(f.actor, key(), added.input),
        ).rejects.toMatchObject({ code: 'INVOICE_ALREADY_POSTED' });
      },
    );
  }

  test('each posted invoice is billed once and several additions have bounded dated parent-filtered pages', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    await release(f, parent, '2026-01-01');
    const reduction = await scopeCredit(f, parent);
    await post(
      f.actor,
      await service.deferrals.proposeScopeReduction(f.actor, key(), reduction.input),
    );
    const a = await supplement(f, parent),
      b = await supplement(f, parent, { date: '2026-03-01' }, { serviceFrom: '2026-03-01' });
    await post(f.actor, a.proposal);
    await post(f.actor, b.proposal);
    expect(
      (
        await service.deferrals.list(f.actor, {
          date: '2026-02-28',
          parentDeferralId: parent.proposal.id,
          onlyOpen: false,
        })
      ).items.map((row) => row.id),
    ).toEqual([a.proposal.id]);
    const first = await service.deferrals.list(f.actor, {
      date: '2026-03-31',
      parentDeferralId: parent.proposal.id,
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.deferrals.list(f.actor, {
      date: '2026-03-31',
      parentDeferralId: parent.proposal.id,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(new Set([...first.items, ...second.items].map((row) => row.id))).toEqual(
      new Set([a.proposal.id, b.proposal.id]),
    );
    expect(second.nextCursor).toBeNull();
    expect(
      await service.deferrals.get(f.actor, { id: parent.proposal.id, date: '2026-03-31' }),
    ).toMatchObject({ amount: '100.00', cancelled: '20.00', remaining: '52.89' });
    const another = await fixture();
    expect(
      (
        await service.deferrals.list(another.actor, {
          date: '2026-03-31',
          parentDeferralId: parent.proposal.id,
          onlyOpen: false,
        })
      ).items,
    ).toHaveLength(0);
  });

  test('a supplement is independently due at month close even when the original month is already allocated', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    await release(f, parent, '2026-01-01');
    const added = await supplement(f, parent);
    await post(f.actor, added.proposal);
    await statement(f);
    await statement(f, '2026-02-01', '2026-02-28');
    await release(f, parent, '2026-02-01');
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ dueCount: 1 });
    await expect(service.periods.close(f.actor, key(), '2026-02-01')).rejects.toMatchObject({
      code: 'DEFERRAL_ALLOCATION_DUE',
    });
    await release(f, added, '2026-02-01');
    await service.periods.close(f.actor, key(), '2026-02-01');
    await expect(supplement(f, parent)).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
  });

  test('parent releases do not invalidate an approved independent addition', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    const added = await supplement(f, parent);
    await service.books.approve(f.actor, key(), added.proposal.id, {
      version: added.proposal.version,
      hash: added.proposal.hash,
    });
    await release(f, parent, '2026-01-01');
    await release(f, parent, '2026-02-01');
    await service.ledger.post(f.actor, key(), exact(added.proposal));
    expect(
      await service.deferrals.get(f.actor, { id: added.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({ remaining: '30.00', supplement: { parentDeferralId: parent.proposal.id } });
  });

  test('a reviewed calendar amendment changes only the supplement and retains its parent link', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    await release(f, parent, '2026-01-01');
    const added = await supplement(f, parent);
    await post(f.actor, added.proposal);
    const before = await service.deferrals.get(f.actor, {
      id: parent.proposal.id,
      date: '2026-04-30',
    });
    const calendar = await amend(f, added);
    await apply(f, { id: calendar.review.id, hash: calendar.review.hash });
    const after = await service.deferrals.get(f.actor, {
      id: added.proposal.id,
      date: '2026-04-30',
    });
    expect(after.schedule.map((row) => row.amount)).toEqual(['12.17', '13.48', '4.35']);
    expect(after.supplement?.parentDeferralId).toBe(parent.proposal.id);
    expect(
      await service.deferrals.get(f.actor, { id: parent.proposal.id, date: '2026-04-30' }),
    ).toEqual(before);
    for (const month of ['2026-02-01', '2026-03-01']) await release(f, parent, month);
    for (const month of ['2026-02-01', '2026-03-01', '2026-04-01']) await release(f, added, month);
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-04-30',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('cancelling original future services does not cancel a separately posted addition', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    await release(f, parent, '2026-01-01');
    const added = await supplement(f, parent);
    await post(f.actor, added.proposal);
    await post(f.actor, await credit(f, parent, 'cancellation', '72.89', '15.31', '88.20'));
    expect(
      await service.deferrals.get(f.actor, { id: parent.proposal.id, date: '2026-02-01' }),
    ).toMatchObject({ status: 'cancelled', remaining: '0.00' });
    await release(f, added, '2026-02-01');
    await release(f, added, '2026-03-01');
    expect(await balance(f)).toMatchObject({ '471': '0.00', '628': '57.11', '4426': '11.99' });
    expect(
      await service.deferrals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-03-31',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test('a newly recorded full cancellation blocks an unposted addition through application and independent database guards', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    await release(f, parent, '2026-01-01');
    const added = await supplement(f, parent),
      approval = await service.books.approve(f.actor, key(), added.proposal.id, {
        version: added.proposal.version,
        hash: added.proposal.hash,
      });
    await post(f.actor, await credit(f, parent, 'cancellation', '72.89', '15.31', '88.20'));
    await expect(service.ledger.post(f.actor, key(), exact(added.proposal))).rejects.toMatchObject({
      code: 'DEFERRAL_SUPPLEMENT_CANCELLED',
    });
    const body = generalBodySchema.parse(added.proposal.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: added.proposal.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    await expect(supplement(f, parent)).rejects.toMatchObject({
      code: 'DEFERRAL_SUPPLEMENT_CANCELLED',
    });
  });

  test('credits on a supplement reduce only its own services, with the parent retaining its original value', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    await release(f, parent, '2026-01-01');
    const added = await supplement(f, parent);
    await post(f.actor, added.proposal);
    const c = await scopeCredit(f, added, { net: '10.00', tax: '2.10', gross: '12.10' });
    await post(f.actor, await service.deferrals.proposeScopeReduction(f.actor, key(), c.input));
    expect(
      await service.deferrals.get(f.actor, { id: parent.proposal.id, date: '2026-03-31' }),
    ).toMatchObject({ amount: '100.00', cancelled: '0.00', remaining: '72.89' });
    const changed = await service.deferrals.get(f.actor, {
      id: added.proposal.id,
      date: '2026-03-31',
    });
    expect(changed).toMatchObject({ amount: '30.00', cancelled: '10.00', remaining: '20.00' });
    expect(changed.schedule.map((row) => row.amount)).toEqual(['13.02', '6.98']);
    for (const month of ['2026-02-01', '2026-03-01']) {
      await release(f, parent, month);
      await release(f, added, month);
    }
    expect(await balance(f)).toMatchObject({ '471': '0.00', '628': '120.00', '4426': '25.20' });
  });

  test('counterparty, evidence, retroactive periods, unsupported invoice types and price-correction bases fail closed', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    for (const change of [
      { changeBasis: 'retroactive_price_increase' },
      { evidenceId: parent.input.evidenceId },
      { evidenceDate: '2025-12-31' },
      { parentDeferralId: key() },
      { serviceFrom: '2026-01-16' },
      { basis: 'uniform_subscription' },
    ])
      await expect(
        supplement(f, parent, {}, change as Partial<DeferralSupplementInput>),
      ).rejects.toThrow();
    await expect(
      supplement(f, parent, {}, {}, (text) => text.replaceAll('87654321', '87654322')),
    ).rejects.toMatchObject({ code: 'DEFERRAL_SUPPLEMENT_ORIGIN' });
    await expect(
      supplement(f, parent, {}, {}, (text) => text.replace('>380<', '>386<')),
    ).rejects.toMatchObject({ code: 'DEFERRAL_SUPPLEMENT_DOCUMENT' });
    await expect(supplement(f, parent, { taxPointDate: '2026-01-01' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PERIOD_TREATMENT',
    });
    await expect(
      service.deferrals.proposeSupplement(f.actor, key(), {
        ...parent.input,
        parentDeferralId: parent.proposal.id,
        changeBasis: 'additional_future_services',
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_ALREADY_POSTED' });
    const draft = await prepare(f);
    await expect(supplement(f, draft)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = await fixture();
    await expect(supplement(other, parent)).rejects.toThrow();
  });

  test('an explicit original-invoice reference must identify the selected contract', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    const reference = (number: string) => (text: string) =>
      text.replace(
        '<cac:AccountingSupplierParty>',
        `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${number}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference><cac:AccountingSupplierParty>`,
      );
    await expect(supplement(f, parent, {}, {}, reference('WRONG-CONTRACT'))).rejects.toMatchObject({
      code: 'DEFERRAL_SUPPLEMENT_DOCUMENT',
    });
    const added = await supplement(f, parent, {}, {}, reference(parent.invoice.body.number));
    await post(f.actor, added.proposal);
    expect(added.invoice.body.originalInvoiceNumber).toBe(parent.invoice.body.number);
  });

  test('a new tax-registration regime needs a distinct treatment even when a new invoice would otherwise validate', async () => {
    const f = await fixture('non_vat'),
      parent = await prepare(f, { direction: 'sale', category: 'O', tax: '0.00', gross: '100.00' });
    await post(f.actor, parent.proposal);
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'normal_vat',
      effectiveFrom: '2026-02-01',
      evidenceId: f.proof.id,
    });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat_collection',
      value: 'no',
      effectiveFrom: '2026-02-01',
      evidenceId: f.proof.id,
    });
    await expect(
      supplement(f, parent, { category: 'S', tax: '6.30', gross: '36.30' }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_SUPPLEMENT_REGIME' });
  });

  test('separate future services use their own 21 percent tax point after a completed 19 percent contract', async () => {
    const f = await fixture('normal_vat', 2025),
      parent = await prepare(
        f,
        { date: '2025-05-01', rate: '19', tax: '19.00', gross: '119.00' },
        { serviceFrom: '2025-05-16', serviceTo: '2025-07-15' },
      );
    await post(f.actor, parent.proposal);
    for (const month of ['2025-05-01', '2025-06-01', '2025-07-01']) await release(f, parent, month);
    const added = await supplement(
      f,
      parent,
      { date: '2025-08-01' },
      { serviceFrom: '2025-08-16', serviceTo: '2025-09-15' },
    );
    await post(f.actor, added.proposal);
    expect(generalBodySchema.parse(added.proposal.body).invoice).toMatchObject({
      taxPointDate: '2025-08-01',
      tax: '6.30',
    });
    expect(added.invoice.body.taxes[0].rate).toBe('21');
    await release(f, added, '2025-08-01');
    await release(f, added, '2025-09-01');
    expect(await balance(f)).toMatchObject({ '471': '0.00', '628': '130.00', '4426': '25.30' });
    expect(
      await service.vat.summary(f.actor, {
        financialYearId: f.financialYear.id,
        from: '2025-08-01',
        to: '2025-09-30',
      }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '6.30' } });
  });

  test('balanced forged additions cannot change parent identity, evidence, purpose or company through direct posting', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    const added = await supplement(f, parent),
      base = generalBodySchema.parse(added.proposal.body);
    const link = (body: GeneralBody) => body.invoice!.deferral!.supplement!;
    const mutations: Array<(body: GeneralBody) => void> = [
      (body) => {
        link(body).parentDeferralId = key();
      },
      (body) => {
        link(body).parentInvoiceId = added.invoice.id;
      },
      (body) => {
        link(body).parentJournalId = key();
      },
      (body) => {
        link(body).parentFinancialYearId = key();
      },
      (body) => {
        link(body).parentProposalHash = '0'.repeat(64);
      },
      (body) => {
        Object.assign(link(body), { schemaVersion: 2 });
      },
      (body) => {
        Object.assign(link(body), { changeBasis: 'retroactive_price_increase' });
      },
      (body) => {
        Reflect.deleteProperty(link(body), 'parentJournalId');
      },
      (body) => {
        Object.assign(body.invoice!.deferral!, { supplement: null });
      },
      (body) => {
        body.invoice!.account = '628.1';
      },
      (body) => {
        body.invoice!.treatmentEvidenceId = parent.input.evidenceId;
        body.invoice!.deferral!.evidenceHash = f.proof.hash;
      },
      (body) => {
        body.invoice!.deferral!.evidenceDate = '2025-12-31';
      },
    ];
    async function reject(body: GeneralBody) {
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
    for (const mutate of mutations) {
      const body = structuredClone(base);
      mutate(body);
      await reject(body);
    }
    const proof = await source(
      f.actor,
      'Independent agreement for a different domestic counterparty',
    );
    const file = await source(
      f.actor,
      invoiceXml({
        number: key(),
        date: '2026-02-01',
        net: '30.00',
        tax: '6.30',
        gross: '36.30',
      }).replaceAll('87654321', '87654322'),
      'different-supplier.xml',
    );
    const invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
    const ordinary = await service.deferrals.proposeInvoice(f.actor, key(), {
      ...parent.input,
      invoiceId: invoice.id,
      recognitionDate: '2026-02-01',
      evidenceDate: '2026-02-01',
      evidenceId: proof.id,
      serviceFrom: '2026-02-01',
      serviceTo: '2026-03-15',
    });
    const wrongParty = generalBodySchema.parse(ordinary.body);
    wrongParty.invoice!.deferral!.supplement = link(base);
    await reject(wrongParty);
    expect(
      await db.orm
        .select()
        .from(deferralSupplements)
        .where(eq(deferralSupplements.companyId, f.company.id)),
    ).toHaveLength(0);
    await post(f.actor, added.proposal);
    await expect(
      db.orm
        .update(deferralSupplements)
        .set({ parentDeferralId: added.proposal.id })
        .where(eq(deferralSupplements.deferralId, added.proposal.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .delete(deferralSupplements)
        .where(eq(deferralSupplements.deferralId, added.proposal.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .insert(deferralSupplements)
        .values({
          companyId: f.company.id,
          deferralId: parent.proposal.id,
          parentDeferralId: added.proposal.id,
          createdBy: ownerId,
        })
        .execute(),
    ).rejects.toThrow();
  });

  test('a cross-year parent link preserves annual openings and source evidence without duplicating prior VAT', async () => {
    const f = await fixture('normal_vat', 2025),
      parent = await prepare(
        f,
        { date: '2025-12-10' },
        { serviceFrom: '2025-12-16', serviceTo: '2026-01-15' },
      );
    const parentEntry = await post(f.actor, parent.proposal);
    await release(f, parent, '2025-12-01');
    const year = await service.foundation.createYear(f.actor, key(), {
      kind: 'financial',
      label: '2026',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const added = await supplement(f, parent, {}, { financialYearId: year.id });
    await post(f.actor, added.proposal);
    await release(f, parent, '2026-01-01', year.id);
    expect(
      await service.deferrals.reconcile(f.actor, { financialYearId: year.id, date: '2026-02-15' }),
    ).toMatchObject({ status: 'needs_review', prepaid: { difference: '-48.39' } });
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: year.id,
        evidenceId: f.proof.id,
        date: year.from,
        purpose: 'opening',
        description: 'Independent carry of approved prior-year positions',
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
    await release(f, added, '2026-02-01', year.id);
    await release(f, added, '2026-03-01', year.id);
    expect(await balance(f)).toMatchObject({ '628': '51.61', '4426': '21.00' });
    expect(await balance(f, year.id)).toMatchObject({
      '471': '0.00',
      '628': '78.39',
      '4426': '27.30',
    });
    expect(await service.vat.summary(f.actor, { financialYearId: year.id })).toMatchObject({
      status: 'reconciled',
      totals: { inputTax: '6.30' },
    });
    expect(
      await service.deferrals.get(f.actor, { id: added.proposal.id, date: '2026-03-31' }),
    ).toMatchObject({
      supplement: {
        parentFinancialYearId: f.financialYear.id,
        parentJournalId: parentEntry.entry.id,
      },
    });
  });

  test('concurrent preparation, large exact bani, export and fresh restore retain one immutable parent edge', async () => {
    const f = await fixture('non_vat'),
      parent = await prepare(f, { direction: 'sale', category: 'O', tax: '0.00', gross: '100.00' });
    await post(f.actor, parent.proposal);
    const added = await supplement(f, parent, {
        net: '9007199254740999.95',
        tax: '0.00',
        gross: '9007199254740999.95',
      }),
      commandKey = key();
    const [a, b] = await Promise.all([
      service.deferrals.proposeSupplement(f.actor, commandKey, added.input),
      service.deferrals.proposeSupplement(f.actor, commandKey, added.input),
    ]);
    expect(a).toEqual(b);
    const postKey = key(),
      posted = await post(f.actor, a, postKey);
    await release(f, added, '2026-02-01');
    await release(f, added, '2026-03-01');
    const state = await service.deferrals.get(f.actor, { id: a.id, date: '2026-03-31' });
    expect(state).toMatchObject({
      allocated: '9007199254740999.95',
      remaining: '0.00',
      supplement: { parentDeferralId: parent.proposal.id },
    });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.deferralSupplements).toHaveLength(1);
    expect(exported.deferralSupplements[0].parentDeferralId).toBe(parent.proposal.id);
    await backup(db, objects, join(directory, 'supplement-backup'));
    const restored = await restore(
        join(directory, 'supplement-backup'),
        join(directory, 'supplement-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.deferrals.proposeSupplement(f.actor, commandKey, added.input)).toEqual(a);
      expect(await copy.ledger.post(f.actor, postKey, exact(a))).toEqual(posted.entry);
      expect(await copy.deferrals.get(f.actor, { id: a.id, date: '2026-03-31' })).toEqual(state);
      expect((await copy.documents.read(f.actor, added.proof.id)).bytes).toEqual(
        (await service.documents.read(f.actor, added.proof.id)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(deferralSupplements)
          .where(eq(deferralSupplements.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
    } finally {
      await copyDb.close();
    }
  });

  test('official MCP prepares and revises an addition, exposes parent-filtered reads, waits for approval and checks live revocation', async () => {
    const f = await fixture(),
      parent = await prepare(f);
    await post(f.actor, parent.proposal);
    const added = await supplement(f, parent),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Supplement assistant',
        scopes: [
          'deferrals.proposeSupplement',
          'deferrals.reviseSupplement',
          'deferrals.get',
          'deferrals.list',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    const app = createApp(service, { publicUrl: 'http://localhost:3000', authSecret: secret }).app;
    const client = new Client(
      { name: 'supplement-contract', version: '1' },
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
      expect(names).toContain('deferrals.proposeSupplement');
      expect(names).not.toContain('books.approve');
      const a = proposalOutput.parse(
        (await call('deferrals.proposeSupplement', added.input)).structuredContent,
      );
      expect((await call('ledger.post', exact(a))).isError).toBe(true);
      await service.books.approve(f.actor, key(), a.id, { version: a.version, hash: a.hash });
      const b = proposalOutput.parse(
        (
          await call('deferrals.reviseSupplement', {
            ...added.input,
            id: a.id,
            version: a.version,
            serviceTo: '2026-04-10',
          })
        ).structuredContent,
      );
      expect((await call('ledger.post', exact(b))).isError).toBe(true);
      await service.books.approve(f.actor, key(), b.id, { version: b.version, hash: b.hash });
      const postKey = key();
      expect((await call('ledger.post', exact(b), postKey)).isError).not.toBe(true);
      const state = deferralPositionOutput.parse(
        (await call('deferrals.get', { id: b.id, date: '2026-02-01' })).structuredContent,
      );
      expect(state.supplement?.parentDeferralId).toBe(parent.proposal.id);
      const page = await call('deferrals.list', {
        date: '2026-02-01',
        parentDeferralId: parent.proposal.id,
      });
      expect((page.structuredContent as { items: unknown[] }).items).toHaveLength(1);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(call('ledger.post', exact(b), postKey)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test.each(['purchase', 'sale'] as const)(
    '%s: one bank movement settles both invoices and a supplemental credit creates only its own refund',
    async (direction) => {
      const f = await fixture(),
        parent = await prepare(f, { direction });
      await post(f.actor, parent.proposal);
      await release(f, parent, '2026-01-01');
      const added = await supplement(f, parent);
      await post(f.actor, added.proposal);
      async function bank(
        from: string,
        to: string,
        opening: string,
        closing: string,
        date: string,
        amount: string,
      ) {
        const file = await source(
          f.actor,
          `movement_id,booking_date,amount,currency,reference\n${key()},${date},${amount},RON,Contract invoices\n`,
          'statement.csv',
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
      const afterPayment = direction === 'purchase' ? '842.70' : '1157.30';
      const payment = await bank(
        '2026-02-01',
        '2026-02-09',
        '1000.00',
        afterPayment,
        '2026-02-05',
        direction === 'purchase' ? '-157.30' : '157.30',
      );
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: payment.id,
          allocations: [
            { invoiceId: parent.invoice.id, amount: '121.00' },
            { invoiceId: added.invoice.id, amount: '36.30' },
          ],
        }),
      );
      const c = await scopeCredit(
        f,
        added,
        { date: '2026-02-10', net: '10.00', tax: '2.10', gross: '12.10' },
        { cancelFrom: '2026-03-01' },
      );
      await post(f.actor, await service.deferrals.proposeScopeReduction(f.actor, key(), c.input));
      expect(
        await service.positions.read(f.actor, { invoiceId: parent.invoice.id, date: '2026-02-10' }),
      ).toMatchObject({ balance: '0.00' });
      expect(
        await service.positions.read(f.actor, { invoiceId: added.invoice.id, date: '2026-02-10' }),
      ).toMatchObject({ balance: '-12.10', status: 'refund_due' });
      const finalBank = direction === 'purchase' ? '854.80' : '1145.20';
      const refund = await bank(
        '2026-02-10',
        '2026-02-28',
        afterPayment,
        finalBank,
        '2026-02-20',
        direction === 'purchase' ? '12.10' : '-12.10',
      );
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: refund.id,
          allocations: [{ invoiceId: added.invoice.id, amount: '-12.10' }],
        }),
      );
      for (const month of ['2026-02-01', '2026-03-01']) {
        await release(f, parent, month);
        await release(f, added, month);
      }
      expect(await balance(f)).toMatchObject({
        '5121': finalBank,
        [direction === 'purchase' ? '471' : '472']: '0.00',
        [direction === 'purchase' ? '401' : '4111']: '0.00',
      });
    },
  );
});
