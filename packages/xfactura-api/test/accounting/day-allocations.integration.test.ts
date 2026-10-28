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
} from '../../source/accounting/domain';
import {
  facts,
  proposals,
  journals,
  journalLines,
  actionReviews,
  deferralReschedules,
  deferralPostings,
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
  secret = 'synthetic-calendar-day-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-day-allocations-'));
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
        email: 'calendar-days@example.test',
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
async function books(f: Fixture) {
  return {
    journals: await db.orm.select().from(journals).where(eq(journals.companyId, f.company.id)),
    lines: await db.orm.select().from(journalLines).where(eq(journalLines.companyId, f.company.id)),
  };
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

describe('actual-day deferred services', () => {
  test('December/January partial months reconcile only after an explicit carried opening', async () => {
    const f = await fixture('normal_vat', 2025),
      root = await prepare(
        f,
        { date: '2025-12-10' },
        { serviceFrom: '2025-12-16', serviceTo: '2026-01-15' },
      );
    expect(
      generalBodySchema
        .parse(root.proposal.body)
        .invoice!.deferral!.schedule.map((row) => row.amount),
    ).toEqual(['51.61', '48.39']);
    await post(f.actor, root.proposal);
    await release(f, root, '2025-12-01');
    const year = await service.foundation.createYear(f.actor, key(), {
      kind: 'financial',
      label: '2026',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(
      await service.deferrals.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-15' }),
    ).toMatchObject({
      status: 'needs_review',
      prepaid: { ledger: '0.00', remaining: '48.39', difference: '-48.39' },
    });
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: year.id,
        evidenceId: f.proof.id,
        date: year.from,
        purpose: 'opening',
        description: 'Independently supplied carry of source balances',
        sourceReference: 'opening2026',
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
    expect(await balance(f, year.id)).toMatchObject({ '471': '0.00', '628': '48.39' });
    expect(
      await service.deferrals.reconcile(f.actor, { financialYearId: year.id, date: '2026-01-31' }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test.each([
    { label: 'reversed service dates', change: { serviceFrom: '2026-04-01' } },
    { label: 'invalid leap day', change: { serviceFrom: '2026-02-29' } },
    { label: 'mixed basis and method', change: { basis: 'uniform_subscription' } },
    { label: 'future unpublished rules', change: { serviceTo: '2027-01-01' } },
    { label: 'service before invoice', change: { serviceFrom: '2025-12-16' } },
  ])('rejects $label', async ({ change }) => {
    const f = await fixture();
    await expect(prepare(f, {}, change as Partial<DeferralInput>)).rejects.toThrow();
  });

  test('unsupported registration changes inside a month cannot hide behind equal month-end states', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'non_vat',
      effectiveFrom: '2026-01-22',
      evidenceId: f.proof.id,
    });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'normal_vat',
      effectiveFrom: '2026-01-27',
      evidenceId: f.proof.id,
    });
    await expect(release(f, root, '2026-01-01')).rejects.toMatchObject({
      code: 'DEFERRAL_VAT_TRANSITION',
    });
    await expect(prepare(f)).rejects.toMatchObject({ code: 'DEFERRAL_VAT_TRANSITION' });
  });

  test('unreleased due months block close and closed allocation months reject posting', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await statement(f);
    await expect(service.periods.close(f.actor, key(), '2026-01-01')).rejects.toMatchObject({
      code: 'DEFERRAL_ALLOCATION_DUE',
    });
    await release(f, root, '2026-01-01');
    await service.periods.close(f.actor, key(), '2026-01-01');
    await expect(prepare(f)).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
    await expect(
      amend(f, root, {
        date: '2026-01-01',
        evidenceDate: '2026-01-01',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
  });

  test('a day-based amendment cannot move the first partial month or an already recognized month', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await expect(
      amend(f, root, {
        date: '2026-01-01',
        evidenceDate: '2026-01-01',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'DEFERRAL_RESCHEDULE_PERIOD' });
    await release(f, root, '2026-01-01');
    await release(f, root, '2026-02-01');
    await expect(amend(f, root)).rejects.toMatchObject({ code: 'DEFERRAL_EVENT_ORDER' });
  });

  test('the independent posting guard rejects balanced changes to daily dates, counts, policy, method or amounts', async () => {
    const f = await fixture(),
      root = await prepare(f),
      base = generalBodySchema.parse(root.proposal.body);
    const plan = (body: GeneralBody) => {
      const value = body.invoice?.deferral;
      if (value?.schemaVersion !== 2) throw new Error('Daily fixture required');
      return value;
    };
    const mutations: Array<(b: GeneralBody) => void> = [
      (b) => {
        plan(b).serviceDays = 60;
      },
      (b) => {
        plan(b).schedule[0].days = 15;
      },
      (b) => {
        plan(b).schedule[0].serviceFrom = '2026-01-17';
      },
      (b) => {
        plan(b).schedule[2].serviceTo = '2026-03-16';
      },
      (b) => {
        plan(b).schedule[0].amount = '27.12';
        plan(b).schedule[2].amount = '25.42';
      },
      (b) => {
        plan(b).schedule[0].month = '2026-01-02';
      },
      (b) => {
        plan(b).schedule[0].date = '2026-01-30';
      },
      (b) => {
        plan(b).schedule.reverse();
      },
      (b) => {
        plan(b).schedule[1].month = '2026-01-01';
      },
      (b) => {
        Object.assign(plan(b), { rounding: 'model_estimate' });
      },
      (b) => {
        Object.assign(plan(b), { dayCountBasis: '30_360' });
      },
      (b) => {
        Object.assign(plan(b), { method: 'equal_calendar_months' });
      },
      (b) => {
        Object.assign(plan(b), { schemaVersion: 1 });
      },
      (b) => {
        Reflect.deleteProperty(plan(b).schedule[0], 'days');
      },
      (b) => {
        Reflect.deleteProperty(plan(b).schedule[0], 'serviceFrom');
      },
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
        .from(deferralPostings)
        .where(eq(deferralPostings.companyId, f.company.id)),
    ).toHaveLength(0);
    await post(f.actor, root.proposal);
  });

  test('forged approved amendments cannot change days or redistribute a different amount', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    const a = await amend(f, root);
    const mutations: Array<(body: DeferralRescheduleEffect) => void> = [
      (b) => {
        b.afterSchedule[1].amount = '29.58';
        b.afterSchedule[3].amount = '10.56';
      },
      (b) => {
        Object.assign(b.afterSchedule[1], { days: 27 });
      },
      (b) => {
        Reflect.deleteProperty(b.afterSchedule[1], 'days');
      },
      (b) => {
        Reflect.deleteProperty(b.afterSchedule[1], 'serviceTo');
      },
      (b) => {
        Object.assign(b.afterSchedule[0], { days: 17 });
      },
      (b) => {
        b.method = 'equal_calendar_months';
      },
      (b) => {
        b.serviceTo = '2026-04-11';
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
    await apply(f, { id: a.review.id, hash: a.review.hash });
  });

  test('large exact daily values, concurrent retries, export and fresh restore preserve source and release history', async () => {
    const f = await fixture('non_vat'),
      root = await prepare(f, {
        direction: 'sale',
        category: 'O',
        net: '9007199254740999.95',
        tax: '0.00',
        gross: '9007199254740999.95',
      }),
      prepareKey = key(),
      [a, b] = await Promise.all([
        service.deferrals.proposeInvoice(f.actor, prepareKey, root.input),
        service.deferrals.proposeInvoice(f.actor, prepareKey, root.input),
      ]);
    expect(a).toEqual(b);
    expect(
      generalBodySchema.parse(a.body).invoice!.deferral!.schedule.map((row) => row.amount),
    ).toEqual(['2442630306370440.66', '4274603036148271.16', '2289965912222288.13']);
    const commandKey = key(),
      posted = await post(f.actor, a, commandKey);
    await release(f, root, '2026-01-01');
    const state = await service.deferrals.get(f.actor, { id: a.id, date: '2026-01-31' });
    expect(state.allocated).toBe('2442630306370440.66');
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.deferralPostings).toHaveLength(1);
    expect(exported.deferralReleases[0].amountBani).toBe('244263030637044066');
    await backup(db, objects, join(directory, 'day-backup'));
    const restored = await restore(join(directory, 'day-backup'), join(directory, 'day-restored')),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.deferrals.proposeInvoice(f.actor, prepareKey, root.input)).toEqual(a);
      expect(await copy.ledger.post(f.actor, commandKey, exact(a))).toEqual(posted.entry);
      expect(await copy.deferrals.get(f.actor, { id: a.id, date: '2026-01-31' })).toEqual(state);
      expect((await copy.documents.read(f.actor, root.invoice.evidenceId)).bytes).toEqual(
        (await service.documents.read(f.actor, root.invoice.evidenceId)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(deferralReleases)
          .where(eq(deferralReleases.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });

  test('official MCP prepares and revises daily plans, then pauses for human release and calendar approval', async () => {
    const f = await fixture(),
      root = await prepare(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Daily allocation assistant',
        scopes: [
          'deferrals.proposeInvoice',
          'deferrals.reviseInvoice',
          'deferrals.proposeRelease',
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
        { name: 'day-allocation-contract', version: '1' },
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
      expect((await client.listTools()).tools.map((row) => row.name)).not.toContain(
        'books.approve',
      );
      const a = proposalOutput.parse(
        (
          await client.callTool({
            name: 'deferrals.proposeInvoice',
            arguments: { input: root.input, idempotencyKey: key() },
          })
        ).structuredContent,
      );
      await service.books.approve(f.actor, key(), a.id, { version: a.version, hash: a.hash });
      const b = proposalOutput.parse(
        (
          await client.callTool({
            name: 'deferrals.reviseInvoice',
            arguments: {
              input: { ...root.input, id: a.id, version: a.version, serviceTo: '2026-03-16' },
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      );
      expect(generalBodySchema.parse(b.body).invoice!.deferral).toMatchObject({
        schemaVersion: 2,
        serviceDays: 60,
      });
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { input: exact(b), idempotencyKey: key() },
          })
        ).isError,
      ).toBe(true);
      await post(f.actor, b);
      const release = proposalOutput.parse(
        (
          await client.callTool({
            name: 'deferrals.proposeRelease',
            arguments: {
              input: { financialYearId: f.financialYear.id, deferralId: b.id, month: '2026-01-01' },
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      );
      expect(generalBodySchema.parse(release.body).deferralRelease?.amount).toBe('26.66');
      await post(f.actor, release);
      const read = deferralPositionOutput.parse(
        (
          await client.callTool({
            name: 'deferrals.get',
            arguments: { input: { id: b.id, date: '2026-01-31' } },
          })
        ).structuredContent,
      );
      expect(read.schedule[0]).toMatchObject({ days: 16, serviceFrom: '2026-01-16' });
      const agreement = await source(
          f.actor,
          'A new retained agreement changes only future uniform day benefit',
        ),
        input = {
          financialYearId: f.financialYear.id,
          deferralId: b.id,
          date: '2026-02-01',
          effectiveFrom: '2026-02-01',
          serviceTo: '2026-04-10',
          evidenceId: agreement.id,
          evidenceDate: '2026-02-01',
          method: 'actual_calendar_days',
          priceUnchanged: true,
          reason:
            'Preserve recognized days and apply the same remaining value over a new daily period',
        },
        review = reviewOutput.parse(
          (
            await client.callTool({
              name: 'deferrals.proposeReschedule',
              arguments: { input, idempotencyKey: key() },
            })
          ).structuredContent,
        ),
        exactReview = { id: review.id, hash: review.hash };
      expect(
        (
          await client.callTool({
            name: 'reviews.execute',
            arguments: { input: exactReview, idempotencyKey: key() },
          })
        ).isError,
      ).toBe(true);
      await service.reviews.approve(f.actor, key(), exactReview);
      const before = await books(f);
      expect(
        (
          await client.callTool({
            name: 'reviews.execute',
            arguments: { input: exactReview, idempotencyKey: key() },
          })
        ).isError,
      ).not.toBe(true);
      expect(await books(f)).toEqual(before);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(
        client.callTool({
          name: 'deferrals.get',
          arguments: { input: { id: b.id, date: '2026-02-28' } },
        }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test('an approved monthly draft is superseded by a daily amendment and needs revision and fresh approval', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    const old = await service.deferrals.proposeRelease(f.actor, key(), {
        financialYearId: f.financialYear.id,
        deferralId: root.proposal.id,
        month: '2026-03-01',
      }),
      approval = await service.books.approve(f.actor, key(), old.id, {
        version: old.version,
        hash: old.hash,
      }),
      a = await amend(f, root);
    await apply(f, { id: a.review.id, hash: a.review.hash });
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
      { financialYearId: f.financialYear.id, deferralId: root.proposal.id, month: '2026-03-01' },
      { id: old.id, version: old.version },
    );
    expect(generalBodySchema.parse(revised.body).deferralRelease?.amount).toBe('32.75');
    await expect(service.ledger.post(f.actor, key(), exact(revised))).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await post(f.actor, revised);
  });
  test.each([
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      deduction: 'full' as const,
      amount: '100.00',
      months: ['27.11', '47.46', '25.43'],
    },
    {
      vat: 'normal_vat' as const,
      direction: 'purchase' as const,
      deduction: 'none' as const,
      amount: '121.00',
      months: ['32.81', '57.42', '30.77'],
    },
    {
      vat: 'non_vat' as const,
      direction: 'purchase' as const,
      deduction: 'none' as const,
      amount: '121.00',
      months: ['32.81', '57.42', '30.77'],
    },
    {
      vat: 'normal_vat' as const,
      direction: 'sale' as const,
      deduction: 'none' as const,
      amount: '100.00',
      months: ['27.11', '47.46', '25.43'],
    },
    {
      vat: 'non_vat' as const,
      direction: 'sale' as const,
      deduction: 'none' as const,
      amount: '100.00',
      months: ['27.11', '47.46', '25.43'],
    },
  ])(
    '$vat $direction $deduction: partial months release exact cost/revenue without repeated VAT',
    async ({ vat, direction, deduction, amount, months }) => {
      const f = await fixture(vat),
        root = await prepare(
          f,
          direction === 'sale' && vat === 'non_vat'
            ? { direction, category: 'O', tax: '0.00', gross: '100.00' }
            : { direction },
          { deduction },
        ),
        body = generalBodySchema.parse(root.proposal.body);
      expect(body.invoice!.deferral).toMatchObject({
        schemaVersion: 2,
        serviceDays: 59,
        dayCountBasis: 'actual_inclusive',
        rounding: 'cumulative_floor_bani',
        amount,
      });
      expect(body.invoice!.deferral!.schedule.map((row) => row.amount)).toEqual([...months]);
      await post(f.actor, root.proposal);
      const position = deferralPositionOutput.parse(
        await service.capabilities.invoke(f.actor, 'deferrals.get', key(), {
          id: root.proposal.id,
          date: '2026-01-31',
        }),
      );
      expect(position).toMatchObject({
        serviceFrom: '2026-01-16',
        serviceTo: '2026-03-15',
        allocation: { serviceDays: 59 },
      });
      expect(position.schedule.map((row) => row.days)).toEqual([16, 28, 15]);
      for (const month of ['2026-01-01', '2026-02-01', '2026-03-01']) await release(f, root, month);
      expect(await balance(f)).toMatchObject(
        direction === 'purchase'
          ? { '471': '0.00', '628': amount }
          : { '472': '0.00', '704': `-${amount}` },
      );
      expect(
        await service.deferrals.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-03-31',
        }),
      ).toMatchObject({ status: 'reconciled' });
      expect(
        await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          from: '2026-02-01',
          to: '2026-03-31',
        }),
      ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00', outputTax: '0.00' } });
    },
  );

  test('a single partial month and zero-value months remain explicit monthly allocations', async () => {
    const f = await fixture('non_vat'),
      one = await prepare(
        f,
        { category: 'O', net: '0.01', tax: '0.00', gross: '0.01' },
        { serviceFrom: '2026-01-16', serviceTo: '2026-01-18' },
      );
    await post(f.actor, one.proposal);
    expect(
      await service.deferrals.get(f.actor, { id: one.proposal.id, date: '2026-01-18' }),
    ).toMatchObject({
      serviceTo: '2026-01-18',
      nextDueMonth: null,
      schedule: [{ days: 3, date: '2026-01-31', amount: '0.01' }],
    });
    await release(f, one, '2026-01-01');
    const tiny = await prepare(f, { category: 'O', net: '0.01', tax: '0.00', gross: '0.01' });
    await post(f.actor, tiny.proposal);
    expect(
      generalBodySchema
        .parse(tiny.proposal.body)
        .invoice!.deferral!.schedule.map((row) => row.amount),
    ).toEqual(['0.00', '0.00', '0.01']);
    await expect(release(f, tiny, '2026-01-01')).rejects.toMatchObject({ code: 'NOTHING_DUE' });
    await statement(f);
    await service.periods.close(f.actor, key(), '2026-01-01');
    await release(f, tiny, '2026-03-01');
    expect((await balance(f))['471']).toBe('0.00');
  });

  test('calendar amendments preserve recognized partial months and cannot change allocation method', async () => {
    const f = await fixture(),
      root = await prepare(f);
    await post(f.actor, root.proposal);
    await release(f, root, '2026-01-01');
    await statement(f);
    await service.periods.close(f.actor, key(), '2026-01-01');
    const before = await books(f),
      a = await amend(f, root);
    expect(a.effect.afterSchedule.map((row) => row.amount)).toEqual([
      '27.11',
      '29.57',
      '32.75',
      '10.57',
    ]);
    expect(a.effect.afterSchedule.slice(1).map((row) => ('days' in row ? row.days : null))).toEqual(
      [28, 31, 10],
    );
    await apply(f, { id: a.review.id, hash: a.review.hash });
    expect(await books(f)).toEqual(before);
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-01-31' }),
    ).toMatchObject({ serviceTo: '2026-03-15', allocation: { serviceDays: 59 } });
    expect(
      await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-04-30' }),
    ).toMatchObject({
      serviceTo: '2026-04-10',
      allocation: { serviceDays: 85 },
      reschedule: { id: a.review.id, version: 1 },
    });
    await expect(amend(f, root, { method: 'equal_calendar_months' })).rejects.toMatchObject({
      code: 'DEFERRAL_RESCHEDULE_METHOD',
    });
    await release(f, root, '2026-02-01');
    const b = await amend(f, root, {
      date: '2026-03-01',
      evidenceDate: '2026-03-01',
      effectiveFrom: '2026-03-01',
      serviceTo: '2026-05-05',
    });
    expect(b.effect.afterSchedule.map((row) => row.amount)).toEqual([
      '27.11',
      '29.57',
      '20.34',
      '19.69',
      '3.29',
    ]);
    await apply(f, { id: b.review.id, hash: b.review.hash });
    for (const month of ['2026-03-01', '2026-04-01', '2026-05-01']) await release(f, root, month);
    expect((await balance(f))['471']).toBe('0.00');
  });

  test.each([{ direction: 'purchase' as const }, { direction: 'sale' as const }])(
    '$direction: commercial discounts preserve the calendar and cancellation retains only earned days',
    async ({ direction }) => {
      const f = await fixture(),
        root = await prepare(f, { direction });
      await post(f.actor, root.proposal);
      await release(f, root, '2026-01-01');
      const discount = await credit(f, root, 'commercial_discount');
      await post(f.actor, discount);
      expect(
        (await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-02-28' }))
          .remaining,
      ).toBe('72.89');
      const cancellation = await credit(f, root, 'cancellation', '72.89', '15.31', '88.20');
      expect(
        generalBodySchema
          .parse(cancellation.body)
          .invoice!.deferralCredit!.months.map((row) => row.amount),
      ).toEqual(['47.46', '25.43']);
      await post(f.actor, cancellation);
      expect(
        await service.deferrals.get(f.actor, { id: root.proposal.id, date: '2026-03-31' }),
      ).toMatchObject({
        allocated: '27.11',
        cancelled: '72.89',
        remaining: '0.00',
        status: 'cancelled',
      });
      expect((await balance(f))[direction === 'purchase' ? '628' : '704']).toBe(
        direction === 'purchase' ? '27.11' : '-27.11',
      );
    },
  );
});
