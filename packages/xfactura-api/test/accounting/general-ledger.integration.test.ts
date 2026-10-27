import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Accounting } from '../../source/accounting/application';
import { createAuth } from '../../source/accounting/auth';
import { createApp } from '../../source/accounting/app';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { LocalObjectStore } from '../../source/accounting/object-store';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import {
  accountingYears,
  approvals,
  facts,
  journalLines,
  ledgerAccounts,
  periods,
  regimeEvents,
} from '../../source/accounting/schema';
import { generalBodySchema, type PostingLine } from '../../source/accounting/domain';
import { proposalView } from '../../source/accounting/capability-contracts';
import type { Actor } from '../../source/accounting/commands';

const secret = 'synthetic-general-ledger-secret-at-least-32-characters';
const publicUrl = 'http://localhost:3000';
const key = () => randomUUID();
const review = (proposal: { version: number; hash: string }) => ({
  version: proposal.version,
  hash: proposal.hash,
});
let directory: string,
  db: Database,
  service: Accounting,
  objects: LocalObjectStore,
  ownerId: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-general-ledger-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  const auth = createAuth(db, { publicUrl, authSecret: secret }, true);
  const owner = await auth.api.signUpEmail({
    body: {
      email: 'ledger@example.test',
      name: 'Ledger reviewer',
      password: 'synthetic-ledger-password',
    },
  });
  ownerId = owner.user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(year = 2026) {
  const company = await service.companies.create(ownerId, key(), {
    name: 'General ledger SRL',
    cui: '12345678',
    year,
  });
  const actor = { actorId: ownerId, companyId: company.id };
  const years = await service.foundation.years(actor);
  const financialYear = years.find((item) => item.kind === 'financial')!;
  const fiscalYear = years.find((item) => item.kind === 'fiscal')!;
  const source = await service.documents.record(actor, key(), {
    filename: 'reviewed-facts.txt',
    mediaType: 'text/plain',
    bytes: Buffer.from(`Independent fixture for ${company.id}`),
  });
  const input = {
    financialYearId: financialYear.id,
    evidenceId: source.id,
    date: `${year}-10-01`,
    purpose: 'general' as const,
    description: 'Înregistrare verificată',
    sourceReference: key(),
    lines: [
      { account: '5121', debit: '1000.00', credit: '0.00' },
      { account: '1012', debit: '0.00', credit: '1000.00' },
    ],
  };
  return { actor, company, years, financialYear, fiscalYear, source, input };
}
async function approveAndPost(
  actor: Actor,
  proposal: { id: string; version: number; hash: string },
) {
  await service.books.approve(actor, key(), proposal.id, review(proposal));
  return service.ledger.post(actor, key(), {
    id: proposal.id,
    version: proposal.version,
    hash: proposal.hash,
  });
}

describe('general ledger, years and company accounting configuration', () => {
  test('seeds the sourced chart and distinct financial/fiscal years idempotently', async () => {
    const f = await fixture();
    expect(f.financialYear.id).not.toBe(f.fiscalYear.id);
    const chart = await service.foundation.accounts(f.actor, { limit: 1000 });
    expect(chart.items.length).toBeGreaterThan(500);
    expect(chart.chart.status).toBe('reference');
    for (const code of ['401', '4111', '4426', '4427', '704', '2813'])
      expect(chart.items.find((item) => item.code === code)?.postable).toBe(true);
    expect(chart.items.find((item) => item.code === '44')?.postable).toBe(false);
    await migrate(db);
    expect(await service.foundation.years(f.actor)).toEqual(f.years);
    expect((await service.foundation.accounts(f.actor, { limit: 1000 })).items).toEqual(
      chart.items,
    );
  });

  test('year-scoped balances do not add two years of opening positions', async () => {
    const f = await fixture(2025);
    const next = await service.foundation.createYear(f.actor, key(), {
      kind: 'financial',
      label: '2026',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const lines = [
      { account: '5121', debit: '1000.00', credit: '0.00' },
      { account: '4111', debit: '500.00', credit: '0.00' },
      { account: '401', debit: '0.00', credit: '200.00' },
      { account: '1012', debit: '0.00', credit: '1300.00' },
    ];
    for (const year of [f.financialYear, next]) {
      const proposal = await service.ledger.propose(f.actor, key(), {
        ...f.input,
        financialYearId: year.id,
        date: year.from,
        purpose: 'opening',
        lines,
      });
      await approveAndPost(f.actor, proposal);
      const result = await service.ledger.balance(f.actor, { financialYearId: year.id });
      expect(result.balances.find((row) => row.account === '5121')?.closing).toBe('1000.00');
      const state = await service.overview(f.actor, year.id);
      expect(state.journals).toHaveLength(1);
      expect(state.balances.find((row) => row.account === '4111')?.balance).toBe('500.00');
    }
    await expect(service.queries.summary(f.actor)).rejects.toMatchObject({
      code: 'FINANCIAL_YEAR',
    });
    expect(
      (await service.queries.summary(f.actor, { financialYearId: next.id })).balances.find(
        (row) => row.account === '401',
      )?.balance,
    ).toBe('-200.00');
    const month = await service.ledger.balance(f.actor, {
      financialYearId: next.id,
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(month.balances.find((row) => row.account === '5121')).toMatchObject({
      opening: '1000.00',
      debit: '0.00',
      credit: '0.00',
      closing: '1000.00',
    });
    await expect(
      service.ledger.balance(f.actor, { financialYearId: next.id, from: '2025-12-31' }),
    ).rejects.toMatchObject({ code: 'REPORT_PERIOD' });
    await expect(
      service.foundation.createYear(f.actor, key(), {
        kind: 'financial',
        label: 'Overlap',
        from: '2026-12-01',
        to: '2027-11-30',
      }),
    ).rejects.toThrow();
    const statementSource = await service.documents.record(f.actor, key(), {
      filename: 'empty-month.csv',
      mediaType: 'text/csv',
      bytes: Buffer.from('movement_id,booking_date,amount,currency,reference\n'),
    });
    await service.bank.importStatement(f.actor, key(), {
      evidenceId: statementSource.id,
      bankAccount: 'RO00FIXTURE',
      statementId: '2026-FEB',
      from: '2026-02-01',
      to: '2026-02-28',
      opening: '1000.00',
      closing: '1000.00',
    });
    expect(await service.periods.close(f.actor, key(), '2026-02-01')).toMatchObject({
      month: '2026-02-01',
    });
    expect((await service.overview(f.actor, f.financialYear.id)).closedPeriods).toHaveLength(0);
  });

  // These are independently written posting expectations, not tax-return conformance claims.
  for (const scenario of [
    { year: 2025, date: '2025-03-01', vat: true, tax: '19.00', gross: '119.00' },
    { year: 2025, date: '2025-10-01', vat: true, tax: '21.00', gross: '121.00' },
    { year: 2026, date: '2026-10-01', vat: true, tax: '21.00', gross: '121.00' },
    { year: 2025, date: '2025-10-01', vat: false, tax: '0.00', gross: '100.00' },
    { year: 2026, date: '2026-10-01', vat: false, tax: '0.00', gross: '100.00' },
  ])
    test(`retains explicit ${scenario.vat ? 'VAT' : 'non-VAT'} sales and purchase lines on ${scenario.date}`, async () => {
      const f = await fixture(scenario.year);
      const sales: PostingLine[] = [
        { account: '4111', debit: scenario.gross, credit: '0.00' },
        { account: '704', debit: '0.00', credit: '100.00' },
      ];
      const purchase: PostingLine[] = [
        { account: '628', debit: '100.00', credit: '0.00' },
        { account: '401', debit: '0.00', credit: scenario.gross },
      ];
      if (scenario.vat) {
        sales.push({ account: '4427', debit: '0.00', credit: scenario.tax });
        purchase.push({ account: '4426', debit: scenario.tax, credit: '0.00' });
      }
      for (const [purpose, lines] of [
        ['sale', sales],
        ['purchase', purchase],
      ] as const) {
        const proposal = await service.ledger.propose(f.actor, key(), {
          ...f.input,
          sourceReference: purpose,
          date: scenario.date,
          purpose,
          lines,
        });
        const preview = proposalView.parse(
          await service.capabilities.invoke(f.actor, 'proposals.get', key(), { id: proposal.id }),
        );
        expect(preview.lines).toEqual(lines);
        await approveAndPost(f.actor, proposal);
      }
      const result = await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id });
      const balance = Object.fromEntries(result.balances.map((row) => [row.account, row.closing]));
      expect(balance['4111']).toBe(scenario.gross);
      expect(balance['401']).toBe(`-${scenario.gross}`);
      expect(balance['704']).toBe('-100.00');
      expect(balance['628']).toBe('100.00');
      if (scenario.vat) {
        expect(balance['4427']).toBe(`-${scenario.tax}`);
        expect(balance['4426']).toBe(scenario.tax);
      } else {
        expect(balance['4427']).toBeUndefined();
        expect(balance['4426']).toBeUndefined();
      }
    });

  test('analytical accounts are company-scoped and groups, unknown or future accounts cannot post', async () => {
    const f = await fixture(),
      other = await fixture();
    const account = await service.foundation.createAccount(f.actor, key(), {
      parentCode: '4111',
      code: '4111.CLIENT',
      name: 'Client verificat',
      validFrom: '2026-01-01',
    });
    const input = {
      ...f.input,
      purpose: 'sale',
      lines: [
        { account: account.code, debit: '100.00', credit: '0.00' },
        { account: '704', debit: '0.00', credit: '100.00' },
      ],
    };
    await approveAndPost(f.actor, await service.ledger.propose(f.actor, key(), input));
    for (const code of ['44', '9999', '8031'])
      await expect(
        service.ledger.propose(f.actor, key(), {
          ...input,
          sourceReference: key(),
          lines: [{ ...input.lines[0], account: code }, input.lines[1]],
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT' });
    await expect(
      service.ledger.propose(other.actor, key(), {
        ...input,
        financialYearId: other.financialYear.id,
        evidenceId: other.source.id,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT' });
    await service.foundation.createAccount(f.actor, key(), {
      parentCode: '4111',
      code: '4111.FUTURE',
      name: 'Client viitor',
      validFrom: '2026-12-01',
    });
    await expect(
      service.ledger.propose(f.actor, key(), {
        ...input,
        sourceReference: key(),
        lines: [{ ...input.lines[0], account: '4111.FUTURE' }, input.lines[1]],
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT' });
    await expect(
      db.orm
        .update(ledgerAccounts)
        .set({ name: 'Tampered' })
        .where(eq(ledgerAccounts.companyId, f.actor.companyId))
        .execute(),
    ).rejects.toThrow();
  });

  test('registration history retains evidence and missing classifications remain unknown', async () => {
    const f = await fixture();
    expect((await service.foundation.regimes(f.actor, '2026-01-01')).regimes.vat).toBeNull();
    for (const [date, value] of [
      ['2026-01-01', 'non_vat'],
      ['2026-09-01', 'normal_vat'],
    ] as const)
      await service.foundation.recordRegime(f.actor, key(), {
        axis: 'vat',
        value,
        effectiveFrom: date,
        evidenceId: f.source.id,
      });
    expect((await service.foundation.regimes(f.actor, '2026-08-31')).regimes.vat?.value).toBe(
      'non_vat',
    );
    expect((await service.foundation.regimes(f.actor, '2026-09-01')).regimes.vat?.value).toBe(
      'normal_vat',
    );
    expect((await service.foundation.regimes(f.actor, '2026-09-01')).regimes.income_tax).toBeNull();
    const other = await fixture();
    await expect(
      service.foundation.recordRegime(f.actor, key(), {
        axis: 'income_tax',
        value: 'profit',
        effectiveFrom: '2026-01-01',
        evidenceId: other.source.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      db.orm.delete(regimeEvents).where(eq(regimeEvents.companyId, f.actor.companyId)).execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(accountingYears)
        .set({ label: 'Tampered' })
        .where(eq(accountingYears.companyId, f.actor.companyId))
        .execute(),
    ).rejects.toThrow();
  });

  test('approval binds exact lines; revision and closed periods prevent stale execution', async () => {
    const f = await fixture();
    const first = await service.ledger.propose(f.actor, key(), f.input);
    await expect(
      service.ledger.post(f.actor, key(), {
        id: first.id,
        version: first.version,
        hash: first.hash,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await service.books.approve(f.actor, key(), first.id, review(first));
    const changed = {
      ...f.input,
      lines: [
        { account: '5121', debit: '900.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '900.00' },
      ],
    };
    const second = await service.ledger.propose(f.actor, key(), changed, {
      id: first.id,
      version: 1,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: first.id, version: 1, hash: first.hash }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(
      service.ledger.post(f.actor, key(), {
        id: second.id,
        version: second.version,
        hash: second.hash,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await approveAndPost(f.actor, second);
    expect(
      await service.ledger.post(f.actor, key(), {
        id: second.id,
        version: second.version,
        hash: second.hash,
      }),
    ).toMatchObject({ number: 1 });
    await expect(
      service.ledger.propose(f.actor, key(), f.input, { id: second.id, version: 2 }),
    ).rejects.toMatchObject({ code: 'ALREADY_POSTED' });
    expect(
      await db.orm.select().from(facts).where(eq(facts.companyId, f.actor.companyId)),
    ).toHaveLength(2);
    const next = await service.ledger.propose(f.actor, key(), {
      ...f.input,
      sourceReference: key(),
      date: '2026-11-01',
    });
    await service.books.approve(f.actor, key(), next.id, review(next));
    await db.orm.insert(periods).values({
      companyId: f.actor.companyId,
      month: '2026-11-01',
      closedAt: new Date().toISOString(),
      closedBy: ownerId,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: next.id, version: next.version, hash: next.hash }),
    ).rejects.toThrow();
  });

  test('database guards reject balanced lines differing from approval and normalized-line tampering', async () => {
    const f = await fixture();
    const proposal = await service.ledger.propose(f.actor, key(), f.input);
    const approval = await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    const entry = {
      date: f.input.date,
      kind: 'general' as const,
      sourceId: proposal.id,
      approvalId: approval.id,
      evidenceId: f.source.id,
      description: f.input.description,
      lines: f.input.lines,
    };
    for (const change of [
      { date: '2026-11-01' },
      { description: 'Different description' },
      { lines: [{ account: '4111', debit: '1000.00', credit: '0.00' }, f.input.lines[1]] },
      {
        lines: [
          { account: '5121', debit: '999.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '999.00' },
        ],
      },
    ])
      await expect(
        db.orm.transaction((tx) => postJournal(tx, f.actor, { ...entry, ...change })),
      ).rejects.toThrow();
    const posted = await approveAndPost(f.actor, proposal);
    await expect(
      db.orm
        .update(journalLines)
        .set({ account: '4111' })
        .where(eq(journalLines.journalId, posted.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm.delete(journalLines).where(eq(journalLines.journalId, posted.id)).execute(),
    ).rejects.toThrow();
    const malformed = {
      ...f.input,
      sourceReference: key(),
      lines: [{ account: '5121', debit: 100, credit: '0.00' }, f.input.lines[1]],
    };
    await expect(service.ledger.propose(f.actor, key(), malformed)).rejects.toThrow();
    await expect(
      service.ledger.propose(f.actor, key(), {
        ...f.input,
        lines: [{ account: '5121', debit: '999.99', credit: '0.00' }, f.input.lines[1]],
      }),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });
  });

  test('agents need the new general-posting scope and cannot approve or alter configuration', async () => {
    const f = await fixture();
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'General ledger agent',
      scopes: ['ledger.propose', 'ledger.post', 'books.post', 'proposals.get'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const actor = { ...f.actor, agentId: grant.id };
    const proposal = await service.ledger.propose(actor, key(), f.input);
    await expect(
      service.books.approve(actor, key(), proposal.id, review(proposal)),
    ).rejects.toThrow();
    await expect(
      service.foundation.createYear(actor, key(), {
        kind: 'financial',
        label: '2027',
        from: '2027-01-01',
        to: '2027-12-31',
      }),
    ).rejects.toThrow();
    await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    await expect(
      service.books.post(actor, key(), proposal.id, review(proposal)),
    ).rejects.toMatchObject({ code: 'AGENT_SCOPE' });
    const result = await service.capabilities.invoke(actor, 'ledger.post', key(), {
      id: proposal.id,
      version: proposal.version,
      hash: proposal.hash,
    });
    expect(result).toMatchObject({ number: 1 });
    await service.agents.revoke(f.actor, key(), grant.id);
    await expect(
      service.ledger.post(actor, key(), {
        id: proposal.id,
        version: proposal.version,
        hash: proposal.hash,
      }),
    ).rejects.toThrow();
  });

  test('linked adjustments, exports and restore retain exact large amounts and original entries', async () => {
    const f = await fixture();
    const input = {
      ...f.input,
      lines: [
        { account: '4111', debit: '90071992547409.93', credit: '0.00' },
        { account: '704', debit: '0.00', credit: '90071992547409.93' },
      ],
    };
    const original = await approveAndPost(
      f.actor,
      await service.ledger.propose(f.actor, key(), input),
    );
    const adjustment = await service.ledger.propose(f.actor, key(), {
      ...f.input,
      sourceReference: 'ADJ-1',
      purpose: 'adjustment',
      date: '2026-11-01',
      correctsJournalId: original.id,
      lines: [
        { account: '709', debit: '0.01', credit: '0.00' },
        { account: '4111', debit: '0.00', credit: '0.01' },
      ],
    });
    await approveAndPost(f.actor, adjustment);
    expect(generalBodySchema.parse(adjustment.body).correctsJournalId).toBe(original.id);
    const expected = await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id });
    expect(expected.balances.find((row) => row.account === '4111')?.closing).toBe(
      '90071992547409.92',
    );
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    );
    expect(exported.data.accountingYears).toHaveLength(2);
    expect(exported.data.ledgerAccounts.length).toBeGreaterThan(500);
    expect(
      exported.data.proposals.find((row: { id: string }) => row.id === adjustment.id).body
        .correctsJournalId,
    ).toBe(original.id);
    const snapshot = join(directory, `backup-${key()}`);
    await backup(db, objects, snapshot);
    const target = join(directory, `restore-${key()}`);
    await restore(snapshot, target);
    const restored = new Database(`file:${target}/xfactura.db`);
    try {
      await migrate(restored);
      const copy = new Accounting(restored, new LocalObjectStore(join(target, 'objects')), secret);
      expect(await copy.ledger.balance(f.actor, { financialYearId: f.financialYear.id })).toEqual(
        expected,
      );
      await expect(
        restored.orm
          .delete(journalLines)
          .where(
            and(
              eq(journalLines.companyId, f.actor.companyId),
              eq(journalLines.journalId, original.id),
            ),
          )
          .execute(),
      ).rejects.toThrow();
    } finally {
      await restored.close();
    }
  });

  test('REST and OpenAPI expose the same year, chart and general-posting contracts', async () => {
    const f = await fixture();
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'Read foundation',
      scopes: ['years.list', 'accounts.list', 'ledger.balance'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const app = createApp(service, { publicUrl, authSecret: secret });
    const response = await app.app.request(
      `${publicUrl}/api/accounting/v1/companies/${f.company.id}/capabilities/years.list`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(f.years);
    const discovery = await service.capabilities.list({ ...f.actor, agentId: grant.id });
    expect(discovery.capabilities.map((item) => item.id)).toEqual(
      expect.arrayContaining(['years.list', 'accounts.list', 'ledger.balance']),
    );
    expect(discovery.capabilities.some((item) => item.id === 'ledger.post')).toBe(false);
    const openapi = await (
      await app.app.request(`${publicUrl}/api/accounting/openapi.json`)
    ).json();
    expect(JSON.stringify(openapi)).toContain('ledger.propose');
    expect(
      await db.orm.select().from(approvals).where(eq(approvals.companyId, f.company.id)),
    ).toHaveLength(0);
  });
});
