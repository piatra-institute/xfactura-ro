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
  proposalOutput,
  accrualPositionOutput,
} from '../../source/accounting/capability-contracts';
import { LocalObjectStore } from '../../source/accounting/object-store';
import {
  generalBodySchema,
  type AccrualInput,
  type AccrualAdjustmentInput,
  type AccrualInvoiceInput,
} from '../../source/accounting/domain';
import { accrualAdjustments, journalLines } from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID(),
  review = (proposal: { version: number; hash: string }) => ({
    version: proposal.version,
    hash: proposal.hash,
  }),
  secret = 'synthetic-adjustment-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-accrual-adjustments-'));
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
      name: 'Adjustment reviewer',
      email: 'adjustments@example.test',
      password: 'synthetic-adjustment-password',
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
  const approval = await service.books.approve(actor, key(), proposal.id, review(proposal)),
    entry = await service.ledger.post(actor, commandKey, { id: proposal.id, ...review(proposal) });
  expect(
    await service.ledger.post(actor, commandKey, { id: proposal.id, ...review(proposal) }),
  ).toEqual(entry);
  return { approval, entry };
}
async function fixture(vat: 'normal_vat' | 'non_vat' = 'normal_vat', year = 2026) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Estimate fixture SRL',
      cui: '12345678',
      year,
    }),
    actor = { companyId: company.id, actorId: ownerId },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(actor, 'services.txt', `Retained service evidence ${company.id}`),
    changed = await source(
      actor,
      'new-information.txt',
      `New estimate information retained separately ${company.id}`,
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
  return { actor, company, financialYear, proof, changed, vat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function accrue(f: Fixture, override: Partial<AccrualInput> = {}) {
  const proposal = await service.accruals.propose(f.actor, key(), {
    financialYearId: f.financialYear.id,
    evidenceId: f.proof.id,
    evidenceDate: '2026-01-31',
    reference: key(),
    date: '2026-01-31',
    serviceFrom: '2026-01-01',
    serviceTo: '2026-01-31',
    supplier: { name: 'Supplier SRL', taxId: '87654321', country: 'RO' },
    currency: 'RON',
    account: '628',
    net: '100.00',
    vatCategory: f.vat === 'normal_vat' ? 'S' : 'O',
    taxPointDate: '2026-01-31',
    deduction: f.vat === 'normal_vat' ? 'full' : 'none',
    counterpartyVatCollection: 'no',
    reason: 'Completed services recognized from retained acceptance evidence',
    ...override,
  });
  const posted = await post(f.actor, proposal);
  return { proposal, ...posted };
}
function adjustment(
  f: Fixture,
  accrualId: string,
  override: Partial<AccrualAdjustmentInput> = {},
): AccrualAdjustmentInput {
  return {
    financialYearId: f.financialYear.id,
    accrualId,
    reference: key(),
    evidenceId: f.changed.id,
    evidenceDate: '2026-02-10',
    newInformationDate: '2026-02-10',
    date: '2026-02-10',
    periodBasis: 'current_year_estimate_change',
    action: 'reestimate',
    remainingNet: '120.00',
    reason: 'New evidence changes the remaining estimated price of the services',
    ...override,
  };
}
async function adjust(
  f: Fixture,
  accrualId: string,
  override: Partial<AccrualAdjustmentInput> = {},
) {
  const body = adjustment(f, accrualId, override),
    proposal = await service.accruals.proposeAdjustment(f.actor, key(), body),
    posted = await post(f.actor, proposal);
  return { body, proposal, ...posted };
}
async function imported(f: Fixture, override: XmlInput = {}) {
  const xml = await source(
    f.actor,
    `${key()}.xml`,
    invoiceXml({
      date: '2026-02-15',
      number: key(),
      taxPointDate: '2026-01-31',
      ...(f.vat === 'non_vat' ? { category: 'O', tax: '0.00', gross: '100.00' } : {}),
      ...override,
    }),
  );
  return service.invoices.import(f.actor, key(), { evidenceId: xml.id });
}
function matching(
  f: Fixture,
  invoiceId: string,
  allocations: AccrualInvoiceInput['allocations'],
  date = '2026-02-15',
): AccrualInvoiceInput {
  return {
    financialYearId: f.financialYear.id,
    invoiceId,
    recognitionDate: date,
    receivedDate: date,
    receiptEvidenceId: f.changed.id,
    allocations,
  };
}
async function balances(f: Fixture) {
  return Object.fromEntries(
    (await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id })).balances.map(
      (row) => [row.account, row.closing],
    ),
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
  const proof = await source(
    f.actor,
    `${key()}.csv`,
    `movement_id,booking_date,amount,currency,reference\n${rows}`,
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: proof.id,
    bankAccount: 'RO00ESTIMATE',
    statementId: key(),
    from,
    to,
    opening,
    closing,
  });
}

describe('immutable purchase-accrual estimate changes', () => {
  test('a closed January estimate increases in February, then the actual invoice and payment clear it once', async () => {
    const f = await fixture(),
      original = await accrue(f);
    const preserved = await service.queries.proposal(f.actor, original.proposal.id);
    await statement(f, '2026-01-01', '2026-01-31', '1000.00', '1000.00');
    await service.periods.close(f.actor, key(), '2026-01-01');
    const changed = await adjust(f, original.proposal.id);
    expect(generalBodySchema.parse(changed.proposal.body).lines).toEqual([
      { account: '628', debit: '20.00', credit: '0.00' },
      { account: '408', debit: '0.00', credit: '24.20' },
      { account: '4428', debit: '4.20', credit: '0.00' },
    ]);
    expect(
      await service.accruals.get(f.actor, { id: original.proposal.id, date: '2026-01-31' }),
    ).toMatchObject({
      net: '100.00',
      remainingNet: '100.00',
      adjustedNet: '100.00',
      adjustmentCount: 0,
    });
    expect(
      await service.accruals.get(f.actor, { id: original.proposal.id, date: '2026-02-10' }),
    ).toMatchObject({
      net: '100.00',
      remainingNet: '120.00',
      adjustedNet: '120.00',
      adjustedGross: '145.20',
      adjustmentCount: 1,
    });
    const invoice = await imported(f, { net: '120.00', tax: '25.20', gross: '145.20' });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matching(f, invoice.id, [{ accrualId: original.proposal.id, net: '120.00', tax: '25.20' }]),
      ),
    );
    await statement(
      f,
      '2026-02-01',
      '2026-02-28',
      '1000.00',
      '854.80',
      'PAY,2026-02-20,-145.20,RON,Actual invoice\n',
    );
    await expect(
      service.accruals.proposeAdjustment(
        f.actor,
        key(),
        adjustment(f, original.proposal.id, {
          date: '2026-02-20',
          evidenceDate: '2026-02-20',
          newInformationDate: '2026-02-20',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCRUAL_RESOLVED' });
    const movement = (await service.queries.movements(f.actor, { matched: false })).items[0];
    await post(
      f.actor,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        movementId: movement.id,
        allocations: [{ invoiceId: invoice.id, amount: '145.20' }],
      }),
    );
    await service.periods.close(f.actor, key(), '2026-02-01');
    expect(await balances(f)).toMatchObject({
      '628': '120.00',
      '408': '0.00',
      '4428': '0.00',
      '4426': '25.20',
      '401': '0.00',
      '5121': '854.80',
    });
    const january = await service.ledger.balance(f.actor, {
      financialYearId: f.financialYear.id,
      to: '2026-01-31',
    });
    expect(january.balances.find((row) => row.account === '628')?.closing).toBe('100.00');
    expect(await service.queries.proposal(f.actor, original.proposal.id)).toEqual(preserved);
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '25.20' } });
    expect(
      await service.accruals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test.each([
    {
      vat: 'non_vat' as const,
      category: 'O' as const,
      tax: '0.00',
      gross: '80.00',
      expense: '80.00',
    },
    {
      vat: 'non_vat' as const,
      category: 'S' as const,
      tax: '16.80',
      gross: '96.80',
      expense: '96.80',
    },
    {
      vat: 'normal_vat' as const,
      category: 'S' as const,
      tax: '16.80',
      gross: '96.80',
      expense: '96.80',
    },
  ])(
    'a lower no-deduction estimate retains supplier VAT as cost: $vat/$category',
    async ({ vat, category, tax, gross, expense }) => {
      const f = await fixture(vat),
        original = await accrue(f, { deduction: 'none', vatCategory: category });
      await adjust(f, original.proposal.id, { remainingNet: '80.00' });
      const invoice = await imported(f, { category, net: '80.00', tax, gross });
      await post(
        f.actor,
        await service.accruals.matchInvoice(
          f.actor,
          key(),
          matching(f, invoice.id, [{ accrualId: original.proposal.id, net: '80.00', tax }]),
        ),
      );
      expect(await balances(f)).toMatchObject({
        '628': expense,
        '408': '0.00',
        '401': `-${gross}`,
      });
      expect((await balances(f))['4426']).toBeUndefined();
      expect((await balances(f))['4428']).toBeUndefined();
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00' } });
    },
  );

  test('release reverses only the uninvoiced remainder and retains the supplier invoice position', async () => {
    const f = await fixture(),
      original = await accrue(f),
      invoice = await imported(f, {
        date: '2026-02-05',
        net: '40.00',
        tax: '8.40',
        gross: '48.40',
      });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matching(
          f,
          invoice.id,
          [{ accrualId: original.proposal.id, net: '40.00', tax: '8.40' }],
          '2026-02-05',
        ),
      ),
    );
    const released = await adjust(f, original.proposal.id, {
      action: 'release',
      remainingNet: '0.00',
    });
    expect(generalBodySchema.parse(released.proposal.body).lines).toEqual([
      { account: '628', debit: '0.00', credit: '60.00' },
      { account: '408', debit: '72.60', credit: '0.00' },
      { account: '4428', debit: '0.00', credit: '12.60' },
    ]);
    expect(
      await service.accruals.get(f.actor, { id: original.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({
      status: 'released',
      gross: '121.00',
      adjustedGross: '48.40',
      matchedGross: '48.40',
      remainingGross: '0.00',
    });
    expect(
      (await service.positions.read(f.actor, { invoiceId: invoice.id, date: '2026-02-28' }))
        .balance,
    ).toBe('48.40');
    expect(await balances(f)).toMatchObject({
      '628': '40.00',
      '4426': '8.40',
      '4428': '0.00',
      '408': '0.00',
      '401': '-48.40',
    });
    expect((await service.accruals.list(f.actor, { date: '2026-02-28' })).items).toHaveLength(0);
    expect((await service.accruals.list(f.actor, { date: '2026-01-31' })).items).toHaveLength(1);
    await expect(
      service.accruals.proposeAdjustment(f.actor, key(), adjustment(f, original.proposal.id)),
    ).rejects.toMatchObject({ code: 'ACCRUAL_RESOLVED' });
  });

  test('increases, decreases and full release form immutable dated history without deducting VAT', async () => {
    const f = await fixture(),
      original = await accrue(f),
      increased = await adjust(f, original.proposal.id, { remainingNet: '150.00' });
    const decreased = await adjust(f, original.proposal.id, {
      date: '2026-02-15',
      evidenceDate: '2026-02-15',
      newInformationDate: '2026-02-15',
      remainingNet: '80.00',
    });
    expect(generalBodySchema.parse(decreased.proposal.body).correctsJournalId).toBe(
      increased.entry.id,
    );
    await adjust(f, original.proposal.id, {
      date: '2026-02-20',
      evidenceDate: '2026-02-20',
      newInformationDate: '2026-02-20',
      action: 'release',
      remainingNet: '0.00',
    });
    expect(await balances(f)).toMatchObject({ '628': '0.00', '408': '0.00', '4428': '0.00' });
    expect((await balances(f))['4426']).toBeUndefined();
    const first = await service.accruals.adjustments(f.actor, {
      accrualId: original.proposal.id,
      date: '2026-02-28',
      limit: 1,
    });
    const second = await service.accruals.adjustments(f.actor, {
      accrualId: original.proposal.id,
      date: '2026-02-28',
      limit: 1,
      cursor: first.nextCursor,
    });
    const third = await service.accruals.adjustments(f.actor, {
      accrualId: original.proposal.id,
      date: '2026-02-28',
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.id)).size,
    ).toBe(3);
    expect(third.nextCursor).toBeNull();
    expect(
      (
        await service.accruals.adjustments(f.actor, {
          accrualId: original.proposal.id,
          date: '2026-02-12',
        })
      ).items,
    ).toHaveLength(1);
    expect(
      await service.accruals.get(f.actor, { id: original.proposal.id, date: '2026-02-16' }),
    ).toMatchObject({ remainingNet: '80.00', adjustmentCount: 2 });
    expect(
      await service.accruals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ status: 'reconciled' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00' } });
  });

  test('the original 19% rule survives an estimate change and invoice after the August rate boundary', async () => {
    const f = await fixture('normal_vat', 2025),
      original = await accrue(f, {
        date: '2025-07-31',
        evidenceDate: '2025-07-31',
        serviceFrom: '2025-07-01',
        serviceTo: '2025-07-31',
        taxPointDate: '2025-07-31',
      });
    const changed = await adjust(f, original.proposal.id, {
      date: '2025-08-10',
      evidenceDate: '2025-08-10',
      newInformationDate: '2025-08-10',
      remainingNet: '150.00',
    });
    expect(generalBodySchema.parse(changed.proposal.body).accrualAdjustment).toMatchObject({
      rate: '19',
      delta: { net: '50.00', tax: '9.50', gross: '59.50', deferredTax: '9.50' },
    });
    const invoice = await imported(f, {
      date: '2025-08-15',
      taxPointDate: '2025-07-31',
      rate: '19',
      net: '150.00',
      tax: '28.50',
      gross: '178.50',
    });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matching(
          f,
          invoice.id,
          [{ accrualId: original.proposal.id, net: '150.00', tax: '28.50' }],
          '2025-08-15',
        ),
      ),
    );
    expect(await balances(f)).toMatchObject({
      '628': '150.00',
      '4426': '28.50',
      '4428': '0.00',
      '408': '0.00',
    });
  });

  test('competing adjustments invalidate approved matches and adjustments at both service and database boundaries', async () => {
    const f = await fixture(),
      original = await accrue(f, { net: '200.00' }),
      invoice = await imported(f),
      matchInput = matching(f, invoice.id, [
        { accrualId: original.proposal.id, net: '100.00', tax: '21.00' },
      ]),
      adjustInput = adjustment(f, original.proposal.id, { remainingNet: '300.00' });
    const pendingMatch = await service.accruals.matchInvoice(f.actor, key(), matchInput),
      pendingAdjustment = await service.accruals.proposeAdjustment(f.actor, key(), adjustInput);
    const approvedMatch = await service.books.approve(
        f.actor,
        key(),
        pendingMatch.id,
        review(pendingMatch),
      ),
      approvedAdjustment = await service.books.approve(
        f.actor,
        key(),
        pendingAdjustment.id,
        review(pendingAdjustment),
      );
    await adjust(f, original.proposal.id, { remainingNet: '250.00' });
    await expect(
      service.ledger.post(f.actor, key(), { id: pendingMatch.id, ...review(pendingMatch) }),
    ).rejects.toMatchObject({ code: 'STALE_ACCRUAL_MATCH' });
    await expect(
      service.ledger.post(f.actor, key(), {
        id: pendingAdjustment.id,
        ...review(pendingAdjustment),
      }),
    ).rejects.toMatchObject({ code: 'STALE_ACCRUAL_ADJUSTMENT' });
    for (const [proposal, approval] of [
      [pendingMatch, approvedMatch],
      [pendingAdjustment, approvedAdjustment],
    ] as const) {
      const body = generalBodySchema.parse(proposal.body);
      await expect(
        db.write((tx) =>
          postJournal(tx, f.actor, {
            date: body.date,
            kind: 'general',
            sourceId: proposal.id,
            approvalId: approval.id,
            evidenceId: body.evidenceId,
            description: body.description,
            lines: body.lines,
          }),
        ),
      ).rejects.toThrow();
    }
    const freshMatch = await service.accruals.matchInvoice(f.actor, key(), matchInput, {
      id: pendingMatch.id,
      version: pendingMatch.version,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: freshMatch.id, ...review(freshMatch) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, freshMatch);
    const freshAdjustment = await service.accruals.proposeAdjustment(
      f.actor,
      key(),
      {
        ...adjustInput,
        date: '2026-02-20',
        evidenceDate: '2026-02-20',
        newInformationDate: '2026-02-20',
        remainingNet: '200.00',
      },
      { id: pendingAdjustment.id, version: pendingAdjustment.version },
    );
    await expect(
      service.ledger.post(f.actor, key(), { id: freshAdjustment.id, ...review(freshAdjustment) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, freshAdjustment);
    expect(
      await service.accruals.get(f.actor, { id: original.proposal.id, date: '2026-02-28' }),
    ).toMatchObject({ matchedGross: '121.00', remainingGross: '242.00', adjustedNet: '300.00' });
  });

  test('dates, unsupported period decisions, closed months, foreign company evidence and resolved balances fail closed', async () => {
    const f = await fixture(),
      other = await fixture(),
      original = await accrue(f);
    for (const value of [
      { evidenceDate: '2026-02-11' },
      { newInformationDate: '2026-02-11' },
      { newInformationDate: '2026-01-31', evidenceDate: '2026-01-31' },
      { remainingNet: '100.00' },
      { evidenceId: f.proof.id },
      { remainingNet: '0.00' },
      { action: 'release' as const, remainingNet: '100.00' },
    ])
      await expect(
        service.accruals.proposeAdjustment(
          f.actor,
          key(),
          adjustment(f, original.proposal.id, value),
        ),
      ).rejects.toThrow();
    expect(() =>
      service.accruals.proposeAdjustment(f.actor, key(), {
        ...adjustment(f, original.proposal.id),
        periodBasis: 'prior_period_error',
      }),
    ).toThrow();
    await expect(
      service.accruals.proposeAdjustment(
        f.actor,
        key(),
        adjustment(f, original.proposal.id, { evidenceId: other.changed.id }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.accruals.adjustments(other.actor, {
        accrualId: original.proposal.id,
        date: '2026-02-28',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.accruals.proposeAdjustment(
        other.actor,
        key(),
        adjustment(other, original.proposal.id),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const nextYear = await service.foundation.createYear(f.actor, key(), {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    await expect(
      service.accruals.proposeAdjustment(
        f.actor,
        key(),
        adjustment(f, original.proposal.id, {
          financialYearId: nextYear.id,
          date: '2027-01-10',
          evidenceDate: '2027-01-10',
          newInformationDate: '2027-01-10',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCRUAL_ADJUSTMENT_PERIOD' });
    await statement(f, '2026-01-01', '2026-01-31', '1000.00', '1000.00');
    await service.periods.close(f.actor, key(), '2026-01-01');
    await expect(
      service.accruals.proposeAdjustment(
        f.actor,
        key(),
        adjustment(f, original.proposal.id, {
          date: '2026-01-31',
          evidenceDate: '2026-01-31',
          newInformationDate: '2026-01-31',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat_collection',
      value: 'yes',
      effectiveFrom: '2026-02-01',
      evidenceId: f.changed.id,
    });
    await expect(
      service.accruals.proposeAdjustment(f.actor, key(), adjustment(f, original.proposal.id)),
    ).rejects.toMatchObject({ code: 'ACCRUAL_ADJUSTMENT_VAT_TRANSITION' });
  });

  test('backdated matches cannot consume a future increase and backdated adjustments cannot precede known invoice matches', async () => {
    const f = await fixture(),
      original = await accrue(f);
    await adjust(f, original.proposal.id, {
      date: '2026-02-20',
      evidenceDate: '2026-02-20',
      newInformationDate: '2026-02-20',
      remainingNet: '200.00',
    });
    const invoice = await imported(f, { net: '150.00', tax: '31.50', gross: '181.50' });
    await expect(
      service.accruals.matchInvoice(
        f.actor,
        key(),
        matching(f, invoice.id, [{ accrualId: original.proposal.id, net: '150.00', tax: '31.50' }]),
      ),
    ).rejects.toMatchObject({ code: 'ACCRUAL_INVOICE_ORIGIN' });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matching(
          f,
          invoice.id,
          [{ accrualId: original.proposal.id, net: '150.00', tax: '31.50' }],
          '2026-02-25',
        ),
      ),
    );
    await expect(
      service.accruals.proposeAdjustment(f.actor, key(), adjustment(f, original.proposal.id)),
    ).rejects.toMatchObject({ code: 'ACCRUAL_ADJUSTMENT_DATE' });
  });

  test('a cent-rounding revision can change expense and deferred VAT without changing the liability', async () => {
    const f = await fixture(),
      original = await accrue(f, { net: '0.03' });
    const first = await imported(f, {
      date: '2026-02-05',
      net: '0.02',
      tax: '0.00',
      gross: '0.02',
    });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matching(
          f,
          first.id,
          [{ accrualId: original.proposal.id, net: '0.02', tax: '0.00' }],
          '2026-02-05',
        ),
      ),
    );
    const changed = await adjust(f, original.proposal.id, { remainingNet: '0.02' });
    expect(generalBodySchema.parse(changed.proposal.body).lines).toEqual([
      { account: '628', debit: '0.01', credit: '0.00' },
      { account: '4428', debit: '0.00', credit: '0.01' },
    ]);
    const last = await imported(f, { net: '0.02', tax: '0.00', gross: '0.02' });
    await post(
      f.actor,
      await service.accruals.matchInvoice(
        f.actor,
        key(),
        matching(f, last.id, [{ accrualId: original.proposal.id, net: '0.02', tax: '0.00' }]),
      ),
    );
    expect(await balances(f)).toMatchObject({ '628': '0.04', '4428': '0.00', '408': '0.00' });
    expect(
      await service.accruals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({ status: 'reconciled' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { base: '0.04', inputTax: '0.00' } });
  });

  test('large exact amounts, frozen export and fresh restore retain the adjustment, source bytes and posting retry', async () => {
    const f = await fixture(),
      net = 9007199254740993n,
      after = net + 100000n,
      decimal = (n: bigint) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`,
      tax = (n: bigint) => (n * 21n + 50n) / 100n;
    const original = await accrue(f, { net: decimal(net) }),
      draft = await service.accruals.proposeAdjustment(
        f.actor,
        key(),
        adjustment(f, original.proposal.id, { remainingNet: decimal(after) }),
      );
    expect(generalBodySchema.parse(draft.body).accrualAdjustment?.delta).toEqual({
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
      deferredTax: '210.00',
    });
    const commandKey = key(),
      posted = await post(f.actor, draft, commandKey);
    expect(
      await service.accruals.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).toMatchObject({
      status: 'reconciled',
      liability: { ledger: decimal(after + tax(after)), difference: '0.00' },
    });
    const expected = await service.accruals.get(f.actor, {
        id: original.proposal.id,
        date: '2026-02-28',
      }),
      job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const data = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(data.accrualAdjustments).toHaveLength(1);
    expect(data.accrualAdjustments[0].grossBani).toBe('121000');
    await backup(db, objects, join(directory, 'adjustment-backup'));
    const restored = await restore(
        join(directory, 'adjustment-backup'),
        join(directory, 'adjustment-restore'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.accruals.get(f.actor, { id: original.proposal.id, date: '2026-02-28' }),
      ).toEqual(expected);
      expect(
        await copy.ledger.post(f.actor, commandKey, { id: draft.id, ...review(draft) }),
      ).toEqual(posted.entry);
      expect(
        await copyDb.orm
          .select()
          .from(journalLines)
          .where(eq(journalLines.companyId, f.company.id)),
      ).toEqual(
        await db.orm.select().from(journalLines).where(eq(journalLines.companyId, f.company.id)),
      );
      await expect(
        copyDb.orm
          .delete(accrualAdjustments)
          .where(eq(accrualAdjustments.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(accrualAdjustments)
          .set({ netBani: 0n })
          .where(eq(accrualAdjustments.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      expect((await copy.documents.read(f.actor, f.changed.id)).bytes).toEqual(
        Buffer.from(`New estimate information retained separately ${f.company.id}`),
      );
    } finally {
      await copyDb.close();
    }
  });

  test('MCP prepares and revises adjustments, pauses for human approval and revocation blocks cached execution', async () => {
    const f = await fixture(),
      original = await accrue(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Estimate adjustment agent',
        scopes: [
          'accruals.proposeAdjustment',
          'accruals.reviseAdjustment',
          'accruals.get',
          'accruals.adjustments',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    const publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'adjustment-contract', version: '1' },
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
      expect(names).toContain('accruals.proposeAdjustment');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('ledger.propose');
      const body = adjustment(f, original.proposal.id),
        draft = proposalOutput.parse(
          (
            await client.callTool({
              name: 'accruals.proposeAdjustment',
              arguments: { input: body, idempotencyKey: key() },
            })
          ).structuredContent,
        );
      await service.books.approve(f.actor, key(), draft.id, review(draft));
      const revised = proposalOutput.parse(
        (
          await client.callTool({
            name: 'accruals.reviseAdjustment',
            arguments: {
              input: { ...body, remainingNet: '130.00', id: draft.id, version: draft.version },
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      );
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { input: { id: draft.id, ...review(draft) }, idempotencyKey: key() },
          })
        ).isError,
      ).toBe(true);
      const exact = { input: { id: revised.id, ...review(revised) }, idempotencyKey: key() };
      expect(
        JSON.stringify(await client.callTool({ name: 'ledger.post', arguments: exact })),
      ).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), revised.id, review(revised));
      const result = await client.callTool({ name: 'ledger.post', arguments: exact });
      expect(result.isError).not.toBe(true);
      expect(
        (await client.callTool({ name: 'ledger.post', arguments: exact })).structuredContent,
      ).toEqual(result.structuredContent);
      expect(
        accrualPositionOutput.parse(
          (
            await client.callTool({
              name: 'accruals.get',
              arguments: { input: { id: original.proposal.id, date: '2026-02-28' } },
            })
          ).structuredContent,
        ),
      ).toMatchObject({ remainingNet: '130.00', adjustmentCount: 1 });
      const history = await client.callTool({
        name: 'accruals.adjustments',
        arguments: { input: { accrualId: original.proposal.id, date: '2026-02-28' } },
      });
      expect(history.isError).not.toBe(true);
      expect(JSON.stringify(history.structuredContent)).toContain(revised.id);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(client.callTool({ name: 'ledger.post', arguments: exact })).rejects.toThrow(
        'Unauthorized',
      );
    } finally {
      await client.close();
    }
  });
});
