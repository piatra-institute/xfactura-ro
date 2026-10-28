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
  proposalOutput,
  unbilledSalePositionOutput,
} from '../../source/accounting/capability-contracts';
import {
  canonical,
  generalBodySchema,
  type GeneralBody,
  type UnbilledSaleInput,
  type UnbilledSaleAdjustmentInput,
} from '../../source/accounting/domain';
import {
  facts,
  proposals,
  journals,
  journalLines,
  unbilledSaleMatches,
  unbilledSaleAdjustments,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID(),
  review = (p: { id: string; version: number; hash: string }) => ({
    id: p.id,
    version: p.version,
    hash: p.hash,
  }),
  secret = 'synthetic-sales-estimate-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-sales-estimates-'));
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
        name: 'Sales estimate reviewer',
        email: 'sales-estimates@example.test',
        password: 'synthetic-estimate-password',
      },
    })
  ).user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function source(actor: Actor, text: string, filename = 'new-measurement.txt') {
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
    entry = await service.ledger.post(actor, commandKey, review(p));
  return { approval, entry };
}
async function fixture(
  vat: 'normal_vat' | 'non_vat' = 'normal_vat',
  year = 2026,
  change: Partial<UnbilledSaleInput> = {},
) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Unbilled estimates SRL',
      cui: '12345678',
      year,
    }),
    actor = { actorId: ownerId, companyId: company.id },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(
      actor,
      `Original service measurement and registration evidence ${company.id}`,
      'service.txt',
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
  const root = await service.unbilledSales.propose(actor, key(), {
    financialYearId: financialYear.id,
    evidenceId: proof.id,
    evidenceDate: `${year}-01-20`,
    reference: key(),
    date: `${year}-01-20`,
    serviceFrom: `${year}-01-01`,
    serviceTo: `${year}-01-20`,
    customer: { name: 'Client SRL', taxId: '87654321', country: 'RO' },
    currency: 'RON',
    account: '704',
    net: '100.00',
    vatCategory: vat === 'normal_vat' ? 'S' : 'O',
    taxPointDate: `${year}-01-20`,
    taxPointBasis: 'completed_service',
    measurementBasis: 'estimated_consideration',
    reason: 'Completed services with a documented uncertain measurement of consideration',
    ...change,
  });
  const entry = await post(actor, root);
  return { company, actor, financialYear, proof, root, entry, vat, year };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function adjustment(f: Fixture, change: Partial<UnbilledSaleAdjustmentInput> = {}) {
  const proof = await source(f.actor, `New reliable measurement information ${key()}`),
    input: UnbilledSaleAdjustmentInput = {
      financialYearId: f.financialYear.id,
      unbilledSaleId: f.root.id,
      reference: key(),
      evidenceId: proof.id,
      evidenceDate: `${f.year}-01-25`,
      newInformationDate: `${f.year}-01-25`,
      date: `${f.year}-01-25`,
      periodBasis: 'current_year_estimate_change',
      changeBasis: 'new_measurement_information',
      action: 'reestimate',
      remainingNet: '120.00',
      reason: 'New information revises estimated consideration for the same completed services',
      ...change,
    };
  return {
    input,
    proof,
    proposal: await service.unbilledSales.proposeAdjustment(f.actor, key(), input),
  };
}
async function invoice(
  f: Fixture,
  xml: XmlInput = {},
  amounts = { net: '120.00', tax: f.vat === 'normal_vat' ? '25.20' : '0.00' },
) {
  const file = await source(
      f.actor,
      invoiceXml({
        direction: 'sale',
        number: key(),
        date: `${f.year}-02-01`,
        taxPointDate: generalBodySchema.parse(f.root.body).unbilledSale!.taxPointDate,
        category: f.vat === 'normal_vat' ? 'S' : 'O',
        ...xml,
      }),
      'invoice.xml',
    ),
    invoice = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
  const input = {
    financialYearId: f.financialYear.id,
    invoiceId: invoice.id,
    recognitionDate: invoice.body.issueDate,
    allocations: [{ unbilledSaleId: f.root.id, ...amounts }],
  };
  return {
    invoice,
    input,
    proposal: await service.unbilledSales.matchInvoice(f.actor, key(), input),
  };
}
async function balance(f: Fixture, to?: string) {
  return Object.fromEntries(
    (
      await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id, to })
    ).balances.map((row) => [row.account, row.closing]),
  );
}
async function statement(f: Fixture, month = '2026-01-01', end = '2026-01-31') {
  const file = await source(
    f.actor,
    'movement_id,booking_date,amount,currency,reference\n',
    'statement.csv',
  );
  return service.bank.importStatement(f.actor, key(), {
    evidenceId: file.id,
    bankAccount: 'RO00ESTIMATES',
    statementId: key(),
    from: month,
    to: end,
    opening: '1000.00',
    closing: '1000.00',
  });
}
async function injected(f: Fixture, body: GeneralBody) {
  return db.write(async (tx) => {
    const factId = key(),
      hash = sha256(canonical({ kind: 'general', version: 1, body, factId }));
    await tx.insert(facts).values({
      companyId: f.company.id,
      id: factId,
      kind: 'general',
      evidenceId: body.evidenceId,
      body,
      createdBy: ownerId,
    });
    const [row] = await tx
      .insert(proposals)
      .values({
        companyId: f.company.id,
        id: key(),
        factId,
        kind: 'general',
        version: 1,
        hash,
        body,
        sourceKey: key(),
        createdBy: ownerId,
      })
      .returning();
    return row;
  });
}

describe('reviewed unbilled-sales remeasurement', () => {
  test.each([
    { vat: 'normal_vat' as const, originalTax: '21.00', deltaTax: '4.20', gross: '145.20' },
    { vat: 'non_vat' as const, originalTax: '0.00', deltaTax: '0.00', gross: '120.00' },
  ])(
    '$vat: remeasurement, later invoice and collection preserve original and recognize no revenue twice',
    async ({ vat, originalTax, deltaTax, gross }) => {
      const f = await fixture(vat),
        original = await db.orm
          .select()
          .from(journalLines)
          .where(eq(journalLines.journalId, f.entry.entry.id)),
        a = await adjustment(f);
      expect(generalBodySchema.parse(a.proposal.body).unbilledSaleAdjustment).toMatchObject({
        previousRemaining: { net: '100.00', tax: originalTax },
        remaining: { net: '120.00', gross },
        delta: { net: '20.00', tax: deltaTax },
        taxTreatment: vat === 'normal_vat' ? 'same_service_month' : 'non_vat',
      });
      await expect(service.ledger.post(f.actor, key(), review(a.proposal))).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
      await post(f.actor, a.proposal);
      expect(
        await db.orm
          .select()
          .from(journalLines)
          .where(eq(journalLines.journalId, f.entry.entry.id)),
      ).toEqual(original);
      expect(
        (await service.unbilledSales.get(f.actor, { id: f.root.id, date: '2026-01-24' }))
          .remainingNet,
      ).toBe('100.00');
      expect(
        unbilledSalePositionOutput.parse(
          await service.unbilledSales.get(f.actor, { id: f.root.id, date: '2026-01-25' }),
        ),
      ).toMatchObject({
        net: '100.00',
        adjustedNet: '120.00',
        remainingGross: gross,
        adjustmentCount: 1,
        matchedGross: '0.00',
      });
      const note = await invoice(f, {
        net: '120.00',
        tax: vat === 'normal_vat' ? '25.20' : '0.00',
        gross,
      });
      await post(f.actor, note.proposal);
      expect(await balance(f)).toMatchObject({ '418': '0.00', '4111': gross, '704': '-120.00' });
      const file = await source(
        f.actor,
        `movement_id,booking_date,amount,currency,reference\nPAY,2026-02-02,${gross},RON,Services\n`,
        'statement.csv',
      );
      await service.bank.importStatement(f.actor, key(), {
        evidenceId: file.id,
        bankAccount: 'RO00ESTIMATES',
        statementId: key(),
        from: '2026-02-01',
        to: '2026-02-28',
        opening: '1000.00',
        closing: vat === 'normal_vat' ? '1145.20' : '1120.00',
      });
      const movement = (await service.queries.movements(f.actor, { matched: false })).items[0];
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: f.financialYear.id,
          movementId: movement.id,
          allocations: [{ invoiceId: note.invoice.id, amount: gross }],
        }),
      );
      expect((await balance(f))['4111']).toBe('0.00');
      expect(
        await service.unbilledSales.reconcile(f.actor, {
          financialYearId: f.financialYear.id,
          date: '2026-02-28',
        }),
      ).toMatchObject({ status: 'reconciled', receivable: { unbilled: '0.00' } });
      expect(
        await service.vat.summary(f.actor, {
          financialYearId: f.financialYear.id,
          from: '2026-02-01',
          to: '2026-02-28',
        }),
      ).toMatchObject({ status: 'reconciled', totals: { outputTax: '0.00' } });
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { outputTax: vat === 'normal_vat' ? '25.20' : '0.00' },
      });
    },
  );

  test('normal VAT decrease and residual release create signed working-register movements in the original month', async () => {
    const f = await fixture(),
      a = await adjustment(f, { remainingNet: '80.00' });
    await post(f.actor, a.proposal);
    const b = await adjustment(f, {
      date: '2026-01-26',
      evidenceDate: '2026-01-26',
      newInformationDate: '2026-01-26',
      action: 'release',
      remainingNet: '0.00',
    });
    await post(f.actor, b.proposal);
    expect(await balance(f)).toMatchObject({ '418': '0.00', '704': '0.00', '4427': '0.00' });
    const register = await service.vat.unbilledSaleAdjustments(f.actor, {
      financialYearId: f.financialYear.id,
    });
    expect(register.items.map((row) => row.base).sort()).toEqual(['-20.00', '-80.00']);
    expect(register.items.map((row) => row.outputTax).sort()).toEqual(['-16.80', '-4.20']);
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({
      status: 'reconciled',
      totals: { base: '0.00', outputTax: '0.00' },
      unbilledSaleAdjustmentEntryCount: 2,
    });
    expect(
      await service.unbilledSales.get(f.actor, { id: f.root.id, date: '2026-01-31' }),
    ).toMatchObject({ status: 'released', matchedGross: '0.00', remainingGross: '0.00' });
  });

  test('partially invoiced estimates retain the invoice while only the unbilled remainder changes', async () => {
    const f = await fixture(),
      part = await invoice(
        f,
        { date: '2026-01-22', net: '40.00', tax: '8.40', gross: '48.40' },
        { net: '40.00', tax: '8.40' },
      );
    await post(f.actor, part.proposal);
    const a = await adjustment(f, { remainingNet: '80.00' });
    expect(generalBodySchema.parse(a.proposal.body).unbilledSaleAdjustment).toMatchObject({
      previousRemaining: { net: '60.00' },
      delta: { net: '20.00' },
    });
    await post(f.actor, a.proposal);
    const b = await adjustment(f, {
      date: '2026-01-26',
      newInformationDate: '2026-01-26',
      evidenceDate: '2026-01-26',
      action: 'release',
      remainingNet: '0.00',
    });
    await post(f.actor, b.proposal);
    expect(await balance(f)).toMatchObject({
      '418': '0.00',
      '4111': '48.40',
      '704': '-40.00',
      '4427': '-8.40',
    });
    expect(
      await service.positions.read(f.actor, { invoiceId: part.invoice.id, date: '2026-01-31' }),
    ).toMatchObject({ balance: '48.40' });
    expect(
      await service.unbilledSales.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-01-31',
      }),
    ).toMatchObject({ status: 'reconciled' });
  });

  test.each([
    {
      label: 'VAT in another month',
      change: { date: '2026-02-01', evidenceDate: '2026-02-01', newInformationDate: '2026-02-01' },
      code: 'UNBILLED_SALE_ADJUSTMENT_TAX_PERIOD',
    },
    {
      label: 'old information in another month',
      change: { date: '2026-02-01' },
      code: 'UNBILLED_SALE_ADJUSTMENT_DATE',
    },
    {
      label: 'evidence learned in the future',
      change: { newInformationDate: '2026-01-26' },
      code: 'UNBILLED_SALE_ADJUSTMENT_DATE',
    },
    {
      label: 'new information before original recognition',
      change: { evidenceDate: '2026-01-19', newInformationDate: '2026-01-19' },
      code: 'UNBILLED_SALE_ADJUSTMENT_DATE',
    },
    {
      label: 'unchanged remaining value',
      change: { remainingNet: '100.00' },
      code: 'UNCHANGED_AMOUNT',
    },
    {
      label: 'release with a nonzero value',
      change: { action: 'release', remainingNet: '1.00' },
      code: 'UNBILLED_SALE_ADJUSTMENT_AMOUNT',
    },
    {
      label: 'reestimate with zero value',
      change: { remainingNet: '0.00' },
      code: 'UNBILLED_SALE_ADJUSTMENT_AMOUNT',
    },
  ])('rejects $label', async ({ change, code }) => {
    const f = await fixture();
    await expect(
      adjustment(f, change as Partial<UnbilledSaleAdjustmentInput>),
    ).rejects.toMatchObject({ code });
  });

  test('missing estimate classification, unrelated company/source, source reuse and invoice-only evidence fail closed', async () => {
    const legacy = await fixture('normal_vat', 2026, { measurementBasis: undefined });
    await expect(adjustment(legacy)).rejects.toMatchObject({ code: 'UNBILLED_SALE_MEASUREMENT' });
    const f = await fixture(),
      other = await fixture();
    await expect(adjustment(f, { evidenceId: f.proof.id })).rejects.toMatchObject({
      code: 'UNBILLED_SALE_ADJUSTMENT_EVIDENCE',
    });
    await expect(adjustment(f, { evidenceId: other.proof.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(adjustment(f, { unbilledSaleId: other.root.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const file = await source(
      f.actor,
      invoiceXml({ direction: 'sale', number: key(), date: '2026-01-25' }),
      'invoice.xml',
    );
    await service.invoices.import(f.actor, key(), { evidenceId: file.id });
    await expect(adjustment(f, { evidenceId: file.id })).rejects.toMatchObject({
      code: 'UNBILLED_SALE_ADJUSTMENT_EVIDENCE',
    });
    const a = await adjustment(f);
    await post(f.actor, a.proposal);
    await expect(
      adjustment(f, { remainingNet: '130.00', evidenceId: a.proof.id }),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_ADJUSTMENT_EVIDENCE' });
  });

  test('a fully invoiced or released estimate cannot be reopened and invoiced tax cannot be erased', async () => {
    const f = await fixture(),
      note = await invoice(
        f,
        { net: '100.00', tax: '21.00', gross: '121.00', date: '2026-01-22' },
        { net: '100.00', tax: '21.00' },
      );
    await post(f.actor, note.proposal);
    await expect(adjustment(f)).rejects.toMatchObject({ code: 'UNBILLED_SALE_RESOLVED' });
    const other = await fixture(),
      a = await adjustment(other, { action: 'release', remainingNet: '0.00' });
    await post(other.actor, a.proposal);
    await expect(adjustment(other, { remainingNet: '10.00' })).rejects.toMatchObject({
      code: 'UNBILLED_SALE_RESOLVED',
    });
  });

  test('cross-year or changed-registration estimates and closed recognition months require a separate workflow', async () => {
    const f = await fixture('non_vat'),
      next = await service.foundation.createYear(f.actor, key(), {
        kind: 'financial',
        label: '2027',
        from: '2027-01-01',
        to: '2027-12-31',
      });
    await expect(
      adjustment(f, {
        financialYearId: next.id,
        date: '2027-01-25',
        evidenceDate: '2027-01-25',
        newInformationDate: '2027-01-25',
      }),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_ADJUSTMENT_PERIOD' });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'normal_vat',
      effectiveFrom: '2026-01-24',
      evidenceId: f.proof.id,
    });
    await expect(adjustment(f)).rejects.toMatchObject({
      code: 'UNBILLED_SALE_ADJUSTMENT_VAT_TRANSITION',
    });
    const other = await fixture();
    await statement(other);
    await service.periods.close(other.actor, key(), '2026-01-01');
    await expect(adjustment(other)).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
  });

  test('competing adjustments invalidate each other and a revised draft needs fresh approval', async () => {
    const f = await fixture(),
      a = await adjustment(f),
      b = await adjustment(f, { remainingNet: '130.00' });
    await service.books.approve(f.actor, key(), b.proposal.id, {
      version: b.proposal.version,
      hash: b.proposal.hash,
    });
    await post(f.actor, a.proposal);
    await expect(service.ledger.post(f.actor, key(), review(b.proposal))).rejects.toMatchObject({
      code: 'STALE_UNBILLED_SALE_ADJUSTMENT',
    });
    const revised = await service.unbilledSales.proposeAdjustment(f.actor, key(), b.input, {
      id: b.proposal.id,
      version: b.proposal.version,
    });
    expect(revised.version).toBe(2);
    await expect(service.ledger.post(f.actor, key(), review(revised))).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await post(f.actor, revised);
    expect(await balance(f)).toMatchObject({ '418': '157.30', '704': '-130.00', '4427': '-27.30' });
  });

  test('an approved invoice match is stale after remeasurement, even when it still fits the remaining balance', async () => {
    const f = await fixture(),
      note = await invoice(
        f,
        { net: '100.00', tax: '21.00', gross: '121.00' },
        { net: '100.00', tax: '21.00' },
      ),
      approval = await service.books.approve(f.actor, key(), note.proposal.id, {
        version: note.proposal.version,
        hash: note.proposal.hash,
      });
    const a = await adjustment(f);
    await post(f.actor, a.proposal);
    await expect(service.ledger.post(f.actor, key(), review(note.proposal))).rejects.toMatchObject({
      code: 'STALE_UNBILLED_SALE_MATCH',
    });
    const body = generalBodySchema.parse(note.proposal.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: note.proposal.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const fresh = await service.unbilledSales.matchInvoice(f.actor, key(), note.input, {
      id: note.proposal.id,
      version: note.proposal.version,
    });
    expect(
      generalBodySchema.parse(fresh.body).invoice!.unbilledSaleMatch!.allocations[0]
        .latestAdjustmentJournalId,
    ).toBeDefined();
    await post(f.actor, fresh);
    expect(
      (await service.unbilledSales.get(f.actor, { id: f.root.id, date: '2026-02-28' }))
        .remainingNet,
    ).toBe('20.00');
  });

  test('a posted match invalidates an older adjustment, including independent direct SQL posting', async () => {
    const f = await fixture(),
      a = await adjustment(f),
      approval = await service.books.approve(f.actor, key(), a.proposal.id, {
        version: a.proposal.version,
        hash: a.proposal.hash,
      }),
      note = await invoice(
        f,
        { net: '40.00', tax: '8.40', gross: '48.40', date: '2026-01-23' },
        { net: '40.00', tax: '8.40' },
      );
    await post(f.actor, note.proposal);
    await expect(service.ledger.post(f.actor, key(), review(a.proposal))).rejects.toMatchObject({
      code: 'STALE_UNBILLED_SALE_ADJUSTMENT',
    });
    const body = generalBodySchema.parse(a.proposal.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: a.proposal.id,
          approvalId: approval.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
  });

  test('independent database guards reject balanced changes to budgets, tax, classification, lineage and periods', async () => {
    const f = await fixture(),
      a = await adjustment(f),
      base = generalBodySchema.parse(a.proposal.body);
    const mutations: Array<(b: GeneralBody) => void> = [
      (b) => {
        b.unbilledSaleAdjustment!.previousRemaining.net = '99.00';
      },
      (b) => {
        b.unbilledSaleAdjustment!.remaining.net = '121.00';
      },
      (b) => {
        b.unbilledSaleAdjustment!.delta.net = '21.00';
      },
      (b) => {
        b.unbilledSaleAdjustment!.originalProposalHash = '0'.repeat(64);
      },
      (b) => {
        b.unbilledSaleAdjustment!.previousJournalId = key();
        b.correctsJournalId = b.unbilledSaleAdjustment!.previousJournalId;
      },
      (b) => {
        b.unbilledSaleAdjustment!.positionVersion = 1;
      },
      (b) => {
        b.unbilledSaleAdjustment!.sourceHash = '0'.repeat(64);
      },
      (b) => {
        b.unbilledSaleAdjustment!.taxTreatment = 'non_vat';
      },
      (b) => {
        b.unbilledSaleAdjustment!.changeBasis = 'bad_debt' as 'new_measurement_information';
      },
      (b) => {
        b.unbilledSaleAdjustment!.rate = '19';
      },
      (b) => {
        b.unbilledSaleAdjustment!.account = '709';
        b.lines[1].account = '709';
      },
      (b) => {
        b.unbilledSaleAdjustment!.date = b.date = '2026-02-25';
        b.unbilledSaleAdjustment!.evidenceDate = b.unbilledSaleAdjustment!.newInformationDate =
          '2026-02-25';
      },
      (b) => {
        b.unbilledSale = generalBodySchema.parse(f.root.body).unbilledSale;
      },
      (b) => {
        b.unbilledSaleAdjustment!.delta.tax = '3.20';
        b.unbilledSaleAdjustment!.delta.gross = '23.20';
        b.unbilledSaleAdjustment!.remaining.tax = '24.20';
        b.unbilledSaleAdjustment!.remaining.gross = '144.20';
        b.lines[0].debit = '23.20';
        b.lines[2].credit = '3.20';
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
      await expect(service.ledger.post(f.actor, key(), review(forged))).rejects.toThrow();
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
        .from(unbilledSaleAdjustments)
        .where(eq(unbilledSaleAdjustments.companyId, f.company.id)),
    ).toHaveLength(0);
  });

  test('dated history, cursor pages and open-only reads include signed changes without counting them as invoices', async () => {
    const f = await fixture();
    for (const [day, remainingNet, action] of [
      ['25', '120.00', 'reestimate'],
      ['26', '80.00', 'reestimate'],
      ['27', '0.00', 'release'],
    ] as const) {
      const a = await adjustment(f, {
        date: `2026-01-${day}`,
        evidenceDate: `2026-01-${day}`,
        newInformationDate: `2026-01-${day}`,
        remainingNet,
        action,
      });
      await post(f.actor, a.proposal);
    }
    expect(
      (
        await service.unbilledSales.adjustments(f.actor, {
          unbilledSaleId: f.root.id,
          date: '2026-01-24',
        })
      ).items,
    ).toHaveLength(0);
    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const page = await service.unbilledSales.adjustments(f.actor, {
        unbilledSaleId: f.root.id,
        date: '2026-01-31',
        limit: 1,
        cursor,
      });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(3);
    expect(
      (await service.unbilledSales.list(f.actor, { date: '2026-01-26' })).items.map(
        (row) => row.id,
      ),
    ).toContain(f.root.id);
    expect(
      (await service.unbilledSales.list(f.actor, { date: '2026-01-31' })).items.map(
        (row) => row.id,
      ),
    ).not.toContain(f.root.id);
    expect(
      (
        await service.unbilledSales.list(f.actor, { date: '2026-01-31', onlyOpen: false })
      ).items.find((row) => row.id === f.root.id),
    ).toMatchObject({ status: 'released', matchedGross: '0.00' });
    expect(
      await db.orm
        .select()
        .from(unbilledSaleMatches)
        .where(eq(unbilledSaleMatches.companyId, f.company.id)),
    ).toHaveLength(0);
  });

  test('2025 uses 19% in the original service month, and half-up cent rounding stays exact', async () => {
    const f = await fixture('normal_vat', 2025),
      a = await adjustment(f);
    expect(generalBodySchema.parse(a.proposal.body).unbilledSaleAdjustment).toMatchObject({
      rate: '19',
      remaining: { net: '120.00', tax: '22.80', gross: '142.80' },
      delta: { tax: '3.80' },
    });
    await post(f.actor, a.proposal);
    expect((await balance(f))['4427']).toBe('-22.80');
    const tiny = await fixture('normal_vat', 2026, { net: '0.02' }),
      b = await adjustment(tiny, { remainingNet: '0.03' });
    expect(generalBodySchema.parse(b.proposal.body).unbilledSaleAdjustment).toMatchObject({
      remaining: { net: '0.03', tax: '0.01', gross: '0.04' },
      delta: { net: '0.01', tax: '0.01', gross: '0.02' },
    });
    await post(tiny.actor, b.proposal);
  });

  test('concurrent retries, large exact tax arithmetic, exports and fresh restore retain one immutable adjustment', async () => {
    const f = await fixture('normal_vat', 2026, { net: '5000000000000000.00' }),
      a = await adjustment(f, { remainingNet: '5999999999999999.95' });
    expect(generalBodySchema.parse(a.proposal.body).unbilledSaleAdjustment!.remaining).toEqual({
      net: '5999999999999999.95',
      tax: '1259999999999999.99',
      gross: '7259999999999999.94',
    });
    const prepareKey = key(),
      repeat = { ...a.input, reference: key() },
      [x, y] = await Promise.all([
        service.unbilledSales.proposeAdjustment(f.actor, prepareKey, repeat),
        service.unbilledSales.proposeAdjustment(f.actor, prepareKey, repeat),
      ]);
    expect(x).toEqual(y);
    const commandKey = key();
    await service.books.approve(f.actor, key(), a.proposal.id, {
      version: a.proposal.version,
      hash: a.proposal.hash,
    });
    const [first, second] = await Promise.all([
      service.ledger.post(f.actor, commandKey, review(a.proposal)),
      service.ledger.post(f.actor, commandKey, review(a.proposal)),
    ]);
    expect(first).toEqual(second);
    expect((await balance(f))['418']).toBe('7259999999999999.94');
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.unbilledSaleAdjustments).toHaveLength(1);
    expect(exported.unbilledSaleAdjustments[0].netBani).toBe('99999999999999995');
    await backup(db, objects, join(directory, 'sales-estimate-backup'));
    const restored = await restore(
        join(directory, 'sales-estimate-backup'),
        join(directory, 'sales-estimate-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.ledger.post(f.actor, commandKey, review(a.proposal))).toEqual(first);
      expect(await copy.unbilledSales.get(f.actor, { id: f.root.id, date: '2026-01-31' })).toEqual(
        await service.unbilledSales.get(f.actor, { id: f.root.id, date: '2026-01-31' }),
      );
      expect((await copy.documents.read(f.actor, a.proof.id)).bytes).toEqual(
        (await service.documents.read(f.actor, a.proof.id)).bytes,
      );
      await expect(
        copyDb.orm
          .delete(unbilledSaleAdjustments)
          .where(eq(unbilledSaleAdjustments.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(unbilledSaleAdjustments)
          .set({ netBani: 0n })
          .where(eq(unbilledSaleAdjustments.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      expect(await copy.unbilledSales.proposeAdjustment(f.actor, prepareKey, repeat)).toEqual(x);
    } finally {
      await copyDb.close();
    }
  });

  test('official MCP prepares and revises an estimate, pauses for human approval and honors revocation', async () => {
    const f = await fixture(),
      a = await adjustment(f),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Sales measurement assistant',
        scopes: [
          'unbilledSales.proposeAdjustment',
          'unbilledSales.reviseAdjustment',
          'unbilledSales.adjustments',
          'vat.unbilledSaleAdjustments',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'sales-estimate-contract', version: '1' },
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
      const tools = (await client.listTools()).tools.map((row) => row.name);
      expect(tools).toContain('unbilledSales.proposeAdjustment');
      expect(tools).not.toContain('books.approve');
      const draft = proposalOutput.parse(
        (
          await client.callTool({
            name: 'unbilledSales.proposeAdjustment',
            arguments: { input: { ...a.input, reference: key() }, idempotencyKey: key() },
          })
        ).structuredContent,
      );
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { input: review(draft), idempotencyKey: key() },
          })
        ).isError,
      ).toBe(true);
      await service.books.approve(f.actor, key(), draft.id, {
        version: draft.version,
        hash: draft.hash,
      });
      const revised = proposalOutput.parse(
        (
          await client.callTool({
            name: 'unbilledSales.reviseAdjustment',
            arguments: {
              input: {
                ...a.input,
                reference: generalBodySchema.parse(draft.body).unbilledSaleAdjustment!.reference,
                id: draft.id,
                version: draft.version,
                remainingNet: '130.00',
              },
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      );
      expect(revised.version).toBe(2);
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { input: review(revised), idempotencyKey: key() },
          })
        ).isError,
      ).toBe(true);
      await service.books.approve(f.actor, key(), revised.id, {
        version: revised.version,
        hash: revised.hash,
      });
      expect(
        (
          await client.callTool({
            name: 'ledger.post',
            arguments: { input: review(revised), idempotencyKey: key() },
          })
        ).isError,
      ).not.toBe(true);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(
        client.callTool({
          name: 'unbilledSales.adjustments',
          arguments: { input: { unbilledSaleId: f.root.id, date: '2026-01-31' } },
        }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test('non-VAT changes after a closed month preserve that month and block no unexplained 418 difference', async () => {
    const f = await fixture('non_vat');
    await statement(f);
    await service.periods.close(f.actor, key(), '2026-01-01');
    const a = await adjustment(f, {
      date: '2026-02-10',
      evidenceDate: '2026-02-10',
      newInformationDate: '2026-02-10',
    });
    await post(f.actor, a.proposal);
    expect(await balance(f, '2026-01-31')).toMatchObject({ '418': '100.00', '704': '-100.00' });
    expect(await balance(f)).toMatchObject({ '418': '120.00', '704': '-120.00' });
    await statement(f, '2026-02-01', '2026-02-28');
    await service.periods.close(f.actor, key(), '2026-02-01');
  });
});
