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
  unbilledSalePositionOutput,
} from '../../source/accounting/capability-contracts';
import { LocalObjectStore } from '../../source/accounting/object-store';
import {
  generalBodySchema,
  type PostingLine,
  type UnbilledSaleInput,
  type UnbilledSaleInvoiceInput,
} from '../../source/accounting/domain';
import {
  journalLines,
  unbilledSaleMatches,
  unbilledSalePostings,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const key = () => randomUUID(),
  review = (proposal: { version: number; hash: string }) => ({
    version: proposal.version,
    hash: proposal.hash,
  }),
  secret = 'synthetic-unbilled-sales-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-unbilled-sales-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  const owner = await createAuth(
    db,
    { publicUrl: 'http://localhost:3000', authSecret: secret },
    true,
  ).api.signUpEmail({
    body: {
      name: 'Sales reviewer',
      email: 'unbilled@example.test',
      password: 'synthetic-unbilled-password',
    },
  });
  ownerId = owner.user.id;
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
  const approval = await service.books.approve(actor, key(), proposal.id, review(proposal));
  const input = { id: proposal.id, ...review(proposal) };
  const entry = await service.ledger.post(actor, commandKey, input);
  expect(await service.ledger.post(actor, commandKey, input)).toEqual(entry);
  return { entry, approval };
}
async function fixture(vat: 'normal_vat' | 'non_vat' = 'normal_vat', year = 2026) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Unbilled services SRL',
      cui: '12345678',
      year,
    }),
    actor = { companyId: company.id, actorId: ownerId },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(
      actor,
      'acceptance.txt',
      `Independent retained acceptance of completed services ${company.id}`,
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
      description: 'Solduri inițiale documentate',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  return { actor, company, financialYear, proof, vat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture, override: Partial<UnbilledSaleInput> = {}): UnbilledSaleInput {
  return {
    financialYearId: f.financialYear.id,
    evidenceId: f.proof.id,
    evidenceDate: '2026-01-31',
    reference: key(),
    date: '2026-01-31',
    serviceFrom: '2026-01-01',
    serviceTo: '2026-01-31',
    customer: { name: 'Client servicii SRL', taxId: '87654321', country: 'RO' },
    currency: 'RON',
    account: '704',
    net: '100.00',
    vatCategory: f.vat === 'normal_vat' ? 'S' : 'O',
    taxPointDate: '2026-01-31',
    taxPointBasis: 'completed_service',
    reason: 'Servicii finalizate și acceptate, documentate înainte de emiterea facturii',
    ...override,
  };
}
async function accrue(f: Fixture, override: Partial<UnbilledSaleInput> = {}) {
  const body = input(f, override),
    proposal = await service.unbilledSales.propose(f.actor, key(), body),
    posted = await post(f.actor, proposal);
  return { body, proposal, ...posted };
}
async function imported(f: Fixture, override: XmlInput = {}) {
  const xml = await source(
    f.actor,
    `${key()}.xml`,
    invoiceXml({
      direction: 'sale',
      number: key(),
      date: '2026-02-10',
      taxPointDate: '2026-01-31',
      ...(f.vat === 'non_vat' ? { category: 'O', tax: '0.00', gross: '100.00' } : {}),
      ...override,
    }),
  );
  return service.invoices.import(f.actor, key(), { evidenceId: xml.id });
}
function matchInput(
  f: Fixture,
  invoiceId: string,
  allocations: UnbilledSaleInvoiceInput['allocations'],
  recognitionDate = '2026-02-10',
): UnbilledSaleInvoiceInput {
  return { financialYearId: f.financialYear.id, invoiceId, recognitionDate, allocations };
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
  const evidence = await source(
    f.actor,
    `${key()}.csv`,
    `movement_id,booking_date,amount,currency,reference\n${rows}`,
  );
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: evidence.id,
    bankAccount: 'RO00SALES',
    statementId: key(),
    from,
    to,
    opening,
    closing,
  });
}

describe('completed services before sales invoicing', () => {
  test.each([
    { vat: 'normal_vat' as const, tax: '420.00', gross: '2420.00', closing: '3420.00' },
    { vat: 'non_vat' as const, tax: '0.00', gross: '2000.00', closing: '3000.00' },
  ])(
    'December revenue/VAT stay in 2025 after a January invoice and receipt: $vat',
    async ({ vat, tax, gross, closing }) => {
      const f = await fixture(vat, 2025),
        original = await accrue(f, {
          date: '2025-12-31',
          evidenceDate: '2025-12-31',
          serviceFrom: '2025-12-01',
          serviceTo: '2025-12-31',
          taxPointDate: '2025-12-31',
          net: '2000.00',
        });
      expect(generalBodySchema.parse(original.proposal.body).lines).toEqual([
        { account: '418', debit: gross, credit: '0.00' },
        { account: '704', debit: '0.00', credit: '2000.00' },
        ...(vat === 'normal_vat' ? [{ account: '4427', debit: '0.00', credit: tax }] : []),
      ]);
      expect(await balances(f)).toMatchObject({ '418': gross, '704': '-2000.00' });
      expect((await balances(f))['4428']).toBeUndefined();
      expect(
        await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { base: '2000.00', outputTax: tax },
        unbilledSaleEntryCount: 1,
      });
      const register = await service.capabilities.invoke(f.actor, 'vat.unbilledSales', '', {
        financialYearId: f.financialYear.id,
      });
      expect(register).toMatchObject({
        items: [
          {
            unbilledSaleId: original.proposal.id,
            originalTaxPointDate: '2025-12-31',
            outputTax: tax,
          },
        ],
      });
      await statement(f, '2025-12-01', '2025-12-31', '1000.00', '1000.00');
      await service.periods.close(f.actor, key(), '2025-12-01');
      const financialYear = await service.foundation.createYear(f.actor, key(), {
          kind: 'financial',
          label: '2026',
          from: '2026-01-01',
          to: '2026-12-31',
        }),
        next = { ...f, financialYear };
      const lines: PostingLine[] = [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '418', debit: gross, credit: '0.00' },
        { account: '1171', debit: '0.00', credit: '2000.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
        ...(vat === 'normal_vat' ? [{ account: '4427', debit: '0.00', credit: tax }] : []),
      ];
      await post(
        f.actor,
        await service.ledger.propose(f.actor, key(), {
          financialYearId: financialYear.id,
          evidenceId: f.proof.id,
          date: financialYear.from,
          purpose: 'opening',
          description: 'Solduri reportate documentate',
          sourceReference: 'opening-2026',
          lines,
        }),
      );
      const invoice = await imported(next, {
        date: '2026-01-10',
        taxPointDate: '2025-12-31',
        net: '2000.00',
        tax,
        gross,
      });
      const matched = await service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(
          next,
          invoice.id,
          [{ unbilledSaleId: original.proposal.id, net: '2000.00', tax }],
          '2026-01-10',
        ),
      );
      expect(generalBodySchema.parse(matched.body).lines).toEqual([
        { account: '4111', debit: gross, credit: '0.00' },
        { account: '418', debit: '0.00', credit: gross },
      ]);
      await post(f.actor, matched);
      expect(
        await service.unbilledSales.reconcile(f.actor, {
          financialYearId: financialYear.id,
          date: '2026-01-31',
        }),
      ).toMatchObject({
        status: 'reconciled',
        receivable: { ledger: '0.00', unbilled: '0.00', difference: '0.00' },
      });
      expect((await balances(next))['704']).toBeUndefined();
      expect(
        await service.vat.summary(f.actor, { financialYearId: financialYear.id }),
      ).toMatchObject({
        status: 'reconciled',
        totals: { base: '0.00', gross: '0.00', sourceTax: '0.00', outputTax: '0.00' },
      });
      expect(
        (await service.vat.entries(f.actor, { financialYearId: financialYear.id })).items[0],
      ).toMatchObject({
        base: '0.00',
        outputTax: '0.00',
        previousRecognition: { base: '2000.00', sourceTax: tax, gross },
      });
      await statement(
        next,
        '2026-01-01',
        '2026-01-31',
        '1000.00',
        closing,
        `RECEIPT,2026-01-15,${gross},RON,Servicii facturate\n`,
      );
      const movement = (await service.queries.movements(f.actor, { matched: false })).items[0];
      await post(
        f.actor,
        await service.settlements.propose(f.actor, key(), {
          financialYearId: financialYear.id,
          movementId: movement.id,
          allocations: [{ invoiceId: invoice.id, amount: gross }],
        }),
      );
      await service.periods.close(f.actor, key(), '2026-01-01');
      expect((await balances(next))['5121']).toBe(closing);
      expect(
        (await service.positions.read(f.actor, { invoiceId: invoice.id, date: '2026-01-31' }))
          .balance,
      ).toBe('0.00');
      expect(
        await service.unbilledSales.get(f.actor, { id: original.proposal.id, date: '2025-12-31' }),
      ).toMatchObject({ status: 'open', remainingGross: gross });
      expect(
        await service.unbilledSales.get(f.actor, { id: original.proposal.id, date: '2026-01-31' }),
      ).toMatchObject({ status: 'matched', remainingGross: '0.00' });
      await expect(
        service.unbilledSales.propose(f.actor, key(), original.body),
      ).rejects.toMatchObject({ code: 'UNBILLED_SALE_EXISTS' });
    },
  );

  test('partial/grouped invoices preserve dated positions, bounded pages and one taxable service total', async () => {
    const f = await fixture(),
      a = await accrue(f, { net: '200.00' }),
      b = await accrue(f);
    const invoice = await imported(f, { net: '150.00', tax: '31.50', gross: '181.50' });
    await post(
      f.actor,
      await service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, invoice.id, [
          { unbilledSaleId: a.proposal.id, net: '50.00', tax: '10.50' },
          { unbilledSaleId: b.proposal.id, net: '100.00', tax: '21.00' },
        ]),
      ),
    );
    expect(
      await service.unbilledSales.get(f.actor, { id: a.proposal.id, date: '2026-02-09' }),
    ).toMatchObject({ remainingGross: '242.00', matchedGross: '0.00' });
    expect(
      await service.unbilledSales.get(f.actor, { id: a.proposal.id, date: '2026-02-10' }),
    ).toMatchObject({ remainingGross: '181.50', matchedGross: '60.50' });
    const first = await service.unbilledSales.list(f.actor, { date: '2026-01-31', limit: 1 }),
      second = await service.unbilledSales.list(f.actor, {
        date: '2026-01-31',
        limit: 1,
        cursor: first.nextCursor,
      });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(2);
    expect(
      (await service.unbilledSales.list(f.actor, { date: '2026-02-10' })).items.map(
        (row) => row.id,
      ),
    ).toEqual([a.proposal.id]);
    const last = await imported(f, {
      date: '2026-02-15',
      net: '150.00',
      tax: '31.50',
      gross: '181.50',
    });
    await post(
      f.actor,
      await service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(
          f,
          last.id,
          [{ unbilledSaleId: a.proposal.id, net: '150.00', tax: '31.50' }],
          '2026-02-15',
        ),
      ),
    );
    expect((await service.unbilledSales.list(f.actor, { date: '2026-02-28' })).items).toHaveLength(
      0,
    );
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({
      status: 'reconciled',
      totals: { base: '300.00', sourceTax: '63.00', gross: '363.00', outputTax: '63.00' },
      unbilledSaleEntryCount: 2,
    });
    const page = await service.vat.unbilledSales(f.actor, {
      financialYearId: f.financialYear.id,
      limit: 1,
    });
    const next = await service.vat.unbilledSales(f.actor, {
      financialYearId: f.financialYear.id,
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(page.items).toHaveLength(1);
    expect(next.items).toHaveLength(1);
    expect(next.items[0].unbilledSaleId).not.toBe(page.items[0].unbilledSaleId);
    expect(next.nextCursor).toBeNull();
    expect(
      await service.vat.unbilledSales(f.actor, {
        financialYearId: f.financialYear.id,
        from: '2026-02-01',
      }),
    ).toEqual({ items: [], nextCursor: null });
  });

  test('a later invoice/credit retains July 19% and never consumes unbilled services twice', async () => {
    const f = await fixture('normal_vat', 2025),
      original = await accrue(f, {
        date: '2025-07-31',
        evidenceDate: '2025-07-31',
        serviceFrom: '2025-07-01',
        serviceTo: '2025-07-31',
        taxPointDate: '2025-07-31',
      }),
      invoice = await imported(f, {
        number: 'JUL-SERVICE',
        date: '2025-08-05',
        taxPointDate: '2025-07-31',
        rate: '19',
        tax: '19.00',
        gross: '119.00',
      });
    await post(
      f.actor,
      await service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(
          f,
          invoice.id,
          [{ unbilledSaleId: original.proposal.id, net: '100.00', tax: '19.00' }],
          '2025-08-05',
        ),
      ),
    );
    const credit = await imported(f, {
      credit: true,
      originalNumber: 'JUL-SERVICE',
      date: '2025-09-10',
      taxPointDate: '2025-07-31',
      net: '20.00',
      rate: '19',
      tax: '3.80',
      gross: '23.80',
    });
    const proposal = await service.invoices.proposeCreditNote(f.actor, key(), {
      financialYearId: f.financialYear.id,
      invoiceId: credit.id,
      originalInvoiceId: invoice.id,
      recognitionDate: '2025-09-10',
      treatmentEvidenceId: f.proof.id,
      kind: 'commercial_discount',
      decisionDate: '2025-09-10',
      periodBasis: 'current_period_event',
      reason: 'Reducere comercială negociată ulterior pentru serviciile din iulie',
    });
    expect(generalBodySchema.parse(proposal.body).invoice?.unbilledSaleMatch).toBeUndefined();
    await post(f.actor, proposal);
    expect(
      await service.unbilledSales.get(f.actor, { id: original.proposal.id, date: '2025-09-30' }),
    ).toMatchObject({ status: 'matched', remainingGross: '0.00', matchedGross: '119.00' });
    expect(await balances(f)).toMatchObject({
      '704': '-100.00',
      '709': '20.00',
      '4427': '-15.20',
      '418': '0.00',
      '4111': '95.20',
    });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { base: '80.00', outputTax: '15.20' } });
    const august = await service.vat.summary(f.actor, {
      financialYearId: f.financialYear.id,
      from: '2025-08-01',
      to: '2025-08-31',
    });
    expect(august.totals.outputTax).toBe('0.00');
  });

  test('a same-day invoice may omit a separate tax-point field without recognizing VAT twice', async () => {
    const f = await fixture(),
      original = await accrue(f);
    const invoice = await imported(f, { date: '2026-01-31', taxPointDate: undefined });
    const matched = await service.unbilledSales.matchInvoice(
      f.actor,
      key(),
      matchInput(
        f,
        invoice.id,
        [{ unbilledSaleId: original.proposal.id, net: '100.00', tax: '21.00' }],
        '2026-01-31',
      ),
    );
    await post(f.actor, matched);
    expect(generalBodySchema.parse(matched.body).lines).toEqual([
      { account: '4111', debit: '121.00', credit: '0.00' },
      { account: '418', debit: '0.00', credit: '121.00' },
    ]);
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { base: '100.00', outputTax: '21.00' } });
  });

  test('competing matches invalidate exact approval and database guards; refreshed review posts once', async () => {
    const f = await fixture(),
      original = await accrue(f, { net: '200.00' }),
      a = await imported(f),
      b = await imported(f);
    const matchA = matchInput(f, a.id, [
        { unbilledSaleId: original.proposal.id, net: '100.00', tax: '21.00' },
      ]),
      matchB = matchInput(f, b.id, matchA.allocations);
    const preparedA = await service.unbilledSales.matchInvoice(f.actor, key(), matchA),
      preparedB = await service.unbilledSales.matchInvoice(f.actor, key(), matchB);
    const approvalB = await service.books.approve(f.actor, key(), preparedB.id, review(preparedB));
    await post(f.actor, preparedA);
    await expect(
      service.ledger.post(f.actor, key(), { id: preparedB.id, ...review(preparedB) }),
    ).rejects.toMatchObject({ code: 'STALE_UNBILLED_SALE_MATCH' });
    const body = generalBodySchema.parse(preparedB.body);
    await expect(
      db.write((tx) =>
        postJournal(tx, f.actor, {
          date: body.date,
          kind: 'general',
          sourceId: preparedB.id,
          approvalId: approvalB.id,
          evidenceId: body.evidenceId,
          description: body.description,
          lines: body.lines,
        }),
      ),
    ).rejects.toThrow();
    const refreshed = await service.unbilledSales.matchInvoice(f.actor, key(), matchB, {
      id: preparedB.id,
      version: preparedB.version,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: refreshed.id, ...review(refreshed) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f.actor, refreshed);
    expect(
      (await service.unbilledSales.get(f.actor, { id: original.proposal.id, date: '2026-02-28' }))
        .remainingGross,
    ).toBe('0.00');
  });

  test('unsupported or missing facts fail before posting; another company cannot supply evidence or positions', async () => {
    const f = await fixture(),
      other = await fixture(),
      original = await accrue(f),
      invoice = await imported(f);
    for (const invalid of [
      { date: '2026-02-01' },
      { taxPointDate: '2026-02-01' },
      { evidenceDate: '2026-02-01' },
      { serviceFrom: '2025-12-31' },
      { vatCategory: 'O' as const },
      { account: '701' },
      { net: '0.00' },
      { customer: { name: 'Own company', taxId: f.company.cui, country: 'RO' as const } },
    ])
      await expect(
        service.unbilledSales.propose(f.actor, key(), input(f, invalid)),
      ).rejects.toThrow();
    await expect(
      service.unbilledSales.propose(f.actor, key(), input(f, { evidenceId: other.proof.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.unbilledSales.propose(f.actor, key(), input(f, { evidenceId: invoice.evidenceId })),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_EVIDENCE' });
    await expect(
      service.unbilledSales.get(other.actor, { id: original.proposal.id, date: '2026-02-28' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.unbilledSales.reconcile(other.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-02-28',
      }),
    ).rejects.toMatchObject({ code: 'FINANCIAL_YEAR' });
    await expect(
      service.vat.unbilledSales(other.actor, { financialYearId: f.financialYear.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const allocation = { unbilledSaleId: original.proposal.id, net: '100.00', tax: '21.00' };
    await expect(
      service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, invoice.id, [allocation], '2026-02-11'),
      ),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_INVOICE_DATE' });
    await expect(
      service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, invoice.id, [allocation, allocation]),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_UNBILLED_SALE' });
    await expect(
      service.unbilledSales.matchInvoice(
        other.actor,
        key(),
        matchInput(other, invoice.id, [allocation]),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const wrongDirection = await imported(f, { direction: 'purchase' });
    await expect(
      service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, wrongDirection.id, [allocation]),
      ),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_INVOICE_SCOPE' });
    const noTaxPoint = await imported(f, { taxPointDate: undefined });
    await expect(
      service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, noTaxPoint.id, [allocation]),
      ),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_VAT_RATE' });
    const excessive = await imported(f, { net: '200.00', tax: '42.00', gross: '242.00' });
    await expect(
      service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, excessive.id, [{ ...allocation, net: '200.00', tax: '42.00' }]),
      ),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_OVER_MATCH' });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat_collection',
      value: 'yes',
      effectiveFrom: '2026-02-01',
      evidenceId: f.proof.id,
    });
    await expect(
      service.unbilledSales.matchInvoice(f.actor, key(), matchInput(f, invoice.id, [allocation])),
    ).rejects.toMatchObject({ code: 'UNBILLED_SALE_VAT_TRANSITION' });
  });

  test('missing carried 418 blocks close even when the bank agrees', async () => {
    const f = await fixture('non_vat', 2025);
    await accrue(f, {
      date: '2025-12-31',
      evidenceDate: '2025-12-31',
      serviceFrom: '2025-12-01',
      serviceTo: '2025-12-31',
      taxPointDate: '2025-12-31',
    });
    const financialYear = await service.foundation.createYear(f.actor, key(), {
        kind: 'financial',
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      }),
      next = { ...f, financialYear };
    await post(
      f.actor,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: financialYear.id,
        evidenceId: f.proof.id,
        date: financialYear.from,
        purpose: 'opening',
        description: 'Incomplete opening fixture',
        sourceReference: 'incomplete-opening',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
        ],
      }),
    );
    await statement(next, '2026-01-01', '2026-01-31', '1000.00', '1000.00');
    expect(
      await service.unbilledSales.reconcile(f.actor, {
        financialYearId: financialYear.id,
        date: '2026-01-31',
      }),
    ).toMatchObject({
      status: 'needs_review',
      receivable: { ledger: '0.00', unbilled: '100.00', difference: '-100.00' },
    });
    await expect(service.periods.close(f.actor, key(), '2026-01-01')).rejects.toMatchObject({
      code: 'UNBILLED_SALE_CONTROL_DIFFERENCE',
    });
  });

  test('independent integer amounts above JS safe precision survive matching and control reconciliation', async () => {
    const f = await fixture(),
      netBani = 9007199254740993n,
      taxBani = (netBani * 21n + 50n) / 100n,
      decimal = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
    const net = decimal(netBani),
      tax = decimal(taxBani),
      gross = decimal(netBani + taxBani),
      original = await accrue(f, { net });
    expect(generalBodySchema.parse(original.proposal.body).unbilledSale).toMatchObject({
      tax,
      gross,
    });
    expect(
      await service.unbilledSales.reconcile(f.actor, {
        financialYearId: f.financialYear.id,
        date: '2026-01-31',
      }),
    ).toMatchObject({
      status: 'reconciled',
      receivable: { ledger: gross, unbilled: gross, difference: '0.00' },
    });
    const invoice = await imported(f, { net, tax, gross });
    await post(
      f.actor,
      await service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, invoice.id, [{ unbilledSaleId: original.proposal.id, net, tax }]),
      ),
    );
    expect(await balances(f)).toMatchObject({
      '418': '0.00',
      '4111': gross,
      '704': `-${net}`,
      '4427': `-${tax}`,
    });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { base: net, outputTax: tax } });
  });

  test('revisions invalidate approval; frozen exports and fresh restore retain originals, matches and guard behavior', async () => {
    const f = await fixture(),
      body = input(f),
      draft = await service.unbilledSales.propose(f.actor, key(), body);
    await service.books.approve(f.actor, key(), draft.id, review(draft));
    const changed = await service.unbilledSales.propose(
      f.actor,
      key(),
      { ...body, net: '200.00' },
      { id: draft.id, version: draft.version },
    );
    await expect(
      service.ledger.post(f.actor, key(), { id: draft.id, ...review(draft) }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await post(f.actor, changed);
    const invoice = await imported(f, { net: '200.00', tax: '42.00', gross: '242.00' }),
      matched = await service.unbilledSales.matchInvoice(
        f.actor,
        key(),
        matchInput(f, invoice.id, [{ unbilledSaleId: draft.id, net: '200.00', tax: '42.00' }]),
      );
    const commandKey = key(),
      posted = await post(f.actor, matched, commandKey);
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const data = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(data.unbilledSalePostings).toHaveLength(1);
    expect(data.unbilledSaleMatches).toHaveLength(1);
    const expected = await service.unbilledSales.get(f.actor, { id: draft.id, date: '2026-02-28' });
    await backup(db, objects, join(directory, 'unbilled-backup'));
    const restored = await restore(
        join(directory, 'unbilled-backup'),
        join(directory, 'unbilled-restore'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.unbilledSales.get(f.actor, { id: draft.id, date: '2026-02-28' })).toEqual(
        expected,
      );
      expect(
        await copy.ledger.post(f.actor, commandKey, { id: matched.id, ...review(matched) }),
      ).toEqual(posted.entry);
      expect(
        await copyDb.orm
          .select()
          .from(journalLines)
          .where(eq(journalLines.companyId, f.company.id)),
      ).toEqual(
        await db.orm.select().from(journalLines).where(eq(journalLines.companyId, f.company.id)),
      );
      for (const table of [unbilledSalePostings, unbilledSaleMatches])
        await expect(
          copyDb.orm.delete(table).where(eq(table.companyId, f.company.id)).execute(),
        ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(unbilledSaleMatches)
          .set({ netBani: 0n })
          .where(eq(unbilledSaleMatches.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      expect(await copy.documents.read(f.actor, f.proof.id)).toMatchObject({
        bytes: Buffer.from(`Independent retained acceptance of completed services ${f.company.id}`),
      });
    } finally {
      await copyDb.close();
    }
  });

  test('scoped MCP prepares and reads unbilled services, waits for exact human approval and rejects revoked retries', async () => {
    const f = await fixture(),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Unbilled sales agent',
        scopes: [
          'unbilledSales.propose',
          'unbilledSales.matchInvoice',
          'unbilledSales.get',
          'vat.unbilledSales',
          'ledger.post',
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    const publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'unbilled-sales-contract', version: '1' },
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
      expect(names).toContain('unbilledSales.propose');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('ledger.propose');
      const original = proposalOutput.parse(
        (
          await client.callTool({
            name: 'unbilledSales.propose',
            arguments: { input: input(f), idempotencyKey: key() },
          })
        ).structuredContent,
      );
      const exact = { input: { id: original.id, ...review(original) }, idempotencyKey: key() };
      expect(
        JSON.stringify(await client.callTool({ name: 'ledger.post', arguments: exact })),
      ).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), original.id, review(original));
      expect((await client.callTool({ name: 'ledger.post', arguments: exact })).isError).not.toBe(
        true,
      );
      const invoice = await imported(f),
        matched = proposalOutput.parse(
          (
            await client.callTool({
              name: 'unbilledSales.matchInvoice',
              arguments: {
                input: matchInput(f, invoice.id, [
                  { unbilledSaleId: original.id, net: '100.00', tax: '21.00' },
                ]),
                idempotencyKey: key(),
              },
            })
          ).structuredContent,
        );
      await service.books.approve(f.actor, key(), matched.id, review(matched));
      const posting = { input: { id: matched.id, ...review(matched) }, idempotencyKey: key() },
        posted = await client.callTool({ name: 'ledger.post', arguments: posting });
      expect(
        (await client.callTool({ name: 'ledger.post', arguments: posting })).structuredContent,
      ).toEqual(posted.structuredContent);
      expect(
        unbilledSalePositionOutput.parse(
          (
            await client.callTool({
              name: 'unbilledSales.get',
              arguments: { input: { id: original.id, date: '2026-02-28' } },
            })
          ).structuredContent,
        ),
      ).toMatchObject({ status: 'matched', remainingGross: '0.00' });
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(client.callTool({ name: 'ledger.post', arguments: posting })).rejects.toThrow(
        'Unauthorized',
      );
    } finally {
      await client.close();
    }
  });
});
