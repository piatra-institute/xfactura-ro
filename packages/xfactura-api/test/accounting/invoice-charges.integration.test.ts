import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Accounting } from '../../source/accounting/application';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { createAuth } from '../../source/accounting/auth';
import { createApp } from '../../source/accounting/app';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import { parseInvoiceXml } from '../../source/accounting/invoice-document';
import { canonical, generalBodySchema, type GeneralBody } from '../../source/accounting/domain';
import { invoiceOutput, proposalOutput } from '../../source/accounting/capability-contracts';
import {
  evidence,
  facts,
  proposals,
  journals,
  invoiceDocuments,
  invoicePostings,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceZip } from './fixtures/archive';
import { chargeInvoiceXml } from './fixtures/invoice-charge';
import { allowanceInvoiceXml } from './fixtures/invoice-allowance';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const secret = 'synthetic-invoice-charge-secret-at-least-32-characters';
const key = () => randomUUID();
const review = (proposal: { version: number; hash: string }) => ({
  version: proposal.version,
  hash: proposal.hash,
});
let directory: string, db: Database, service: Accounting, ownerId: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-invoice-charges-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  service = new Accounting(db, new LocalObjectStore(join(directory, 'objects')), secret);
  const owner = await createAuth(
    db,
    { publicUrl: 'http://localhost:3000', authSecret: secret },
    true,
  ).api.signUpEmail({
    body: {
      name: 'Invoice reviewer',
      email: 'invoice-charges@example.test',
      password: 'synthetic-invoice-password',
    },
  });
  ownerId = owner.user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(year = 2026, vat?: 'normal_vat' | 'non_vat') {
  const company = await service.companies.create(ownerId, key(), {
    name: 'Invoice fixture SRL',
    cui: '12345678',
    year,
  });
  const actor = { actorId: ownerId, companyId: company.id };
  const financialYear = (await service.foundation.years(actor)).find(
    (year) => year.kind === 'financial',
  )!;
  const proof = await service.documents.record(actor, key(), {
    filename: 'dated-registration-and-service-proof.txt',
    mediaType: 'text/plain',
    bytes: Buffer.from(`Retained dated synthetic evidence ${company.id}`),
  });
  if (vat)
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
  return { company, actor, financialYear, proof };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function importXml(f: Fixture, input: XmlInput = {}, xml?: string) {
  const source = await service.documents.record(f.actor, key(), {
    filename: `${key()}.xml`,
    mediaType: 'application/xml',
    bytes: Buffer.from(xml ?? invoiceXml(input)),
  });
  const invoice = invoiceOutput.parse(
    await service.capabilities.invoke(f.actor, 'invoices.import', key(), { evidenceId: source.id }),
  );
  return { source, invoice };
}
function postingInput(
  f: Fixture,
  id: string,
  date = '2026-10-01',
  direction = 'purchase',
  deduction = 'full',
) {
  return {
    invoiceId: id,
    financialYearId: f.financialYear.id,
    recognitionDate: date,
    serviceDate: date,
    taxPointDate: date,
    treatmentEvidenceId: f.proof.id,
    account: direction === 'sale' ? '704' : '628',
    deduction,
    counterpartyVatCollection: 'no',
  };
}
async function execute(
  f: Fixture,
  p: { id: string; version: number; hash: string },
  executionKey = key(),
) {
  await service.books.approve(f.actor, key(), p.id, review(p));
  const input = { id: p.id, ...review(p) },
    result = await service.ledger.post(f.actor, executionKey, input);
  expect(await service.ledger.post(f.actor, executionKey, input)).toEqual(result);
  return result;
}
async function charged(f: Fixture, input: Parameters<typeof chargeInvoiceXml>[0] = {}) {
  return importXml(f, {}, chargeInvoiceXml({ number: key(), ...input }));
}
const classification = { documentCharge: 'service_price_component' as const };
const both = { ...classification, documentAllowance: 'commercial_price_reduction' as const };
async function raw(f: Fixture, template: GeneralBody, mutate: (body: GeneralBody) => void) {
  const body = structuredClone(template);
  mutate(body);
  const proposal = await db.write(async (tx) => {
    const factId = key(),
      hash = sha256(canonical({ kind: 'general', version: 1, body, factId }));
    await tx.insert(facts).values({
      id: factId,
      companyId: f.company.id,
      kind: 'general',
      body,
      evidenceId: body.evidenceId,
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
  const approval = await service.books.approve(f.actor, key(), proposal.id, review(proposal));
  return db.write((tx) =>
    postJournal(tx, f.actor, {
      date: body.date,
      kind: 'general',
      sourceId: proposal.id,
      approvalId: approval.id,
      evidenceId: body.evidenceId,
      description: body.description,
      lines: body.lines,
    }),
  );
}

describe('document-level charges forming part of the service price', () => {
  for (const discount of [false, true])
    test.each([
      {
        year: 2025,
        date: '2025-07-01',
        vat: 'normal_vat',
        direction: 'purchase',
        deduction: 'full',
        category: 'S',
        rate: '19',
      },
      {
        year: 2025,
        date: '2025-07-01',
        vat: 'normal_vat',
        direction: 'sale',
        deduction: 'none',
        category: 'S',
        rate: '19',
      },
      {
        year: 2026,
        date: '2026-10-01',
        vat: 'normal_vat',
        direction: 'purchase',
        deduction: 'full',
        category: 'S',
        rate: '21',
      },
      {
        year: 2026,
        date: '2026-10-01',
        vat: 'normal_vat',
        direction: 'purchase',
        deduction: 'none',
        category: 'S',
        rate: '21',
      },
      {
        year: 2026,
        date: '2026-10-01',
        vat: 'normal_vat',
        direction: 'sale',
        deduction: 'none',
        category: 'S',
        rate: '21',
      },
      {
        year: 2026,
        date: '2026-10-01',
        vat: 'non_vat',
        direction: 'purchase',
        deduction: 'none',
        category: 'S',
        rate: '21',
      },
      {
        year: 2026,
        date: '2026-10-01',
        vat: 'non_vat',
        direction: 'purchase',
        deduction: 'none',
        category: 'O',
        rate: '0',
      },
      {
        year: 2026,
        date: '2026-10-01',
        vat: 'non_vat',
        direction: 'sale',
        deduction: 'none',
        category: 'O',
        rate: '0',
      },
    ] as const)(
      `$year $vat $direction $deduction: charge ${discount ? 'with discount' : 'alone'} uses the exact combined price and VAT`,
      async (c) => {
        const f = await fixture(c.year, c.vat),
          net = discount ? '90.00' : '110.00',
          tax =
            c.rate === '19'
              ? discount
                ? '17.10'
                : '20.90'
              : c.rate === '21'
                ? discount
                  ? '18.90'
                  : '23.10'
                : '0.00',
          gross =
            c.rate === '19'
              ? discount
                ? '107.10'
                : '130.90'
              : c.rate === '21'
                ? discount
                  ? '108.90'
                  : '133.10'
                : net,
          a = await charged(f, { ...c, net, tax, gross, allowance: discount ? '20.00' : '0.00' }),
          input = {
            ...postingInput(f, a.invoice.id, c.date, c.direction, c.deduction),
            ...(discount ? both : classification),
          },
          p = await service.invoices.propose(f.actor, key(), input),
          body = generalBodySchema.parse(p.body),
          cost = c.direction === 'purchase' && c.deduction === 'none' ? gross : net;
        expect(a.invoice.body.parserVersion).toBe('ubl-invoice-3');
        expect(body.invoice!.documentCharge).toEqual({
          schemaVersion: 1,
          kind: 'service_price_component',
          lineNet: '100.00',
          allowances: discount ? '20.00' : '0.00',
          total: '10.00',
          net,
          items: [
            {
              sourceIndex: discount ? 1 : 0,
              amount: '10.00',
              reason: 'Configurare suplimentară a serviciului',
              reasonCode: 'AAH',
            },
          ],
        });
        expect(body.invoice!.documentAllowance?.total).toBe(discount ? '20.00' : undefined);
        expect(body.lines).toEqual(
          c.direction === 'purchase'
            ? [
                { account: '628', debit: cost, credit: '0.00' },
                { account: '401', debit: '0.00', credit: gross },
                ...(c.deduction === 'full'
                  ? [{ account: '4426', debit: tax, credit: '0.00' }]
                  : []),
              ]
            : [
                { account: '4111', debit: gross, credit: '0.00' },
                { account: '704', debit: '0.00', credit: net },
                ...(tax === '0.00' ? [] : [{ account: '4427', debit: '0.00', credit: tax }]),
              ],
        );
        await expect(
          service.ledger.post(f.actor, key(), { id: p.id, ...review(p) }),
        ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
        await execute(f, p);
        expect(
          await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
        ).toMatchObject({
          status: 'reconciled',
          totals: {
            inputTax: c.direction === 'purchase' && c.deduction === 'full' ? tax : '0.00',
            outputTax: c.direction === 'sale' ? tax : '0.00',
          },
        });
        expect(
          await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: c.date }),
        ).toMatchObject({ gross, balance: gross });
        expect(await service.invoices.get(f.actor, a.invoice.id)).toEqual(a.invoice);
      },
    );

  test('multiple charge items retain their individual reasons and source indexes', async () => {
    const f = await fixture(2026, 'normal_vat'),
      entry = chargeInvoiceXml().match(/<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/)![0],
      rows =
        entry.replace('10.00', '7.00') +
        entry
          .replace('10.00', '3.00')
          .replace('Configurare suplimentară a serviciului', 'Procesare suplimentară documentată'),
      a = await charged(f, { adjustments: rows }),
      p = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...classification,
      });
    await execute(f, p);
    expect(generalBodySchema.parse(p.body).invoice!.documentCharge!.items).toEqual([
      {
        sourceIndex: 0,
        amount: '7.00',
        reason: 'Configurare suplimentară a serviciului',
        reasonCode: 'AAH',
      },
      {
        sourceIndex: 1,
        amount: '3.00',
        reason: 'Procesare suplimentară documentată',
        reasonCode: 'AAH',
      },
    ]);
  });

  test('each classification is required only for the corresponding positive source amount', async () => {
    const f = await fixture(2026, 'normal_vat'),
      c = await charged(f),
      mixed = await charged(f, { allowance: '20.00', net: '90.00', tax: '18.90', gross: '108.90' });
    await expect(
      service.invoices.propose(f.actor, key(), postingInput(f, c.invoice.id)),
    ).rejects.toMatchObject({ code: 'INVOICE_CHARGE_TREATMENT' });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, mixed.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_TREATMENT' });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, mixed.invoice.id),
        documentAllowance: 'commercial_price_reduction',
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_CHARGE_TREATMENT' });
    const ordinary = await importXml(f, { number: key() });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, ordinary.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_CHARGE_TREATMENT' });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, c.invoice.id),
        documentCharge: 'late_payment_interest',
      }),
    ).rejects.toThrow();
  });

  test('incompatible category/rate, legacy missing details and wrong discounted VAT fail closed', async () => {
    const f = await fixture(2026, 'normal_vat'),
      number = key(),
      contents = chargeInvoiceXml({ number });
    for (const xml of [
      contents.replace('<cac:TaxCategory><cbc:ID>S', '<cac:TaxCategory><cbc:ID>E'),
      contents.replace(
        '<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>21',
        '<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19',
      ),
    ]) {
      const a = await importXml(f, {}, xml.replace(number, key()));
      await expect(
        service.invoices.propose(f.actor, key(), {
          ...postingInput(f, a.invoice.id),
          ...classification,
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_CHARGE_DETAILS' });
    }
    const legacy = await charged(f, { adjustments: '' });
    expect(legacy.invoice.body.parserVersion).toBe('ubl-invoice-1');
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, legacy.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_CHARGE_DETAILS' });
    const wrongTax = await charged(f, {
      allowance: '20.00',
      net: '90.00',
      tax: '21.00',
      gross: '111.00',
    });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, wrongTax.invoice.id),
        ...both,
      }),
    ).rejects.toMatchObject({ code: 'VAT_AMOUNT' });
  });

  test('duplicate amounts, missing reasons, wrong currency, bad percentages and mismatched charge totals cannot become invoice facts', () => {
    const xml = chargeInvoiceXml();
    const mutations = [
      xml.replace('<cbc:Amount currencyID="RON">10.00', '<cbc:Amount currencyID="EUR">10.00'),
      xml.replace(
        '<cbc:Amount currencyID="RON">10.00</cbc:Amount>',
        '<cbc:Amount currencyID="RON">10.00</cbc:Amount><cbc:Amount currencyID="RON">10.00</cbc:Amount>',
      ),
      xml
        .replace(/<cbc:AllowanceChargeReason>[\s\S]*?<\/cbc:AllowanceChargeReason>/, '')
        .replace(/<cbc:AllowanceChargeReasonCode>[\s\S]*?<\/cbc:AllowanceChargeReasonCode>/, ''),
      xml.replace(
        '<cbc:Amount currencyID="RON">10.00</cbc:Amount>',
        '<cbc:MultiplierFactorNumeric>20</cbc:MultiplierFactorNumeric><cbc:Amount currencyID="RON">10.00</cbc:Amount><cbc:BaseAmount currencyID="RON">100.00</cbc:BaseAmount>',
      ),
      xml.replace(
        '<cbc:ChargeTotalAmount currencyID="RON">10.00',
        '<cbc:ChargeTotalAmount currencyID="RON">9.00',
      ),
    ];
    for (const value of mutations) expect(() => parseInvoiceXml(Buffer.from(value))).toThrow();
  });

  test('wrong company, advance type, cash VAT and unrelated service accounts cannot reuse a charge classification', async () => {
    const f = await fixture(2026, 'normal_vat'),
      other = await fixture(2026, 'normal_vat'),
      a = await charged(f);
    await expect(
      service.invoices.propose(other.actor, key(), {
        ...postingInput(other, a.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...classification,
        account: '627',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCOUNT' });
    const advance = await importXml(
      f,
      {},
      chargeInvoiceXml({ number: key() }).replace('InvoiceTypeCode>380<', 'InvoiceTypeCode>386<'),
    );
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, advance.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_CHARGE_DETAILS' });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat_collection',
      value: 'yes',
      effectiveFrom: '2026-09-01',
      evidenceId: f.proof.id,
    });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TREATMENT' });
  });
});

test.each([false, true])(
  'SQLite rejects forged charge proof and balanced wrong effects, discount=%s',
  async (discount) => {
    const f = await fixture(2026, 'normal_vat'),
      a = await charged(
        f,
        discount ? { allowance: '20.00', net: '90.00', tax: '18.90', gross: '108.90' } : {},
      ),
      p = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...(discount ? both : classification),
      }),
      base = generalBodySchema.parse(p.body),
      mutations: Array<(b: GeneralBody) => void> = [
        (b) => {
          Reflect.deleteProperty(b.invoice!, 'documentCharge');
        },
        (b) => {
          b.invoice!.documentCharge!.total = '9.00';
        },
        (b) => {
          b.invoice!.documentCharge!.allowances = '1.00';
        },
        (b) => {
          b.invoice!.documentCharge!.lineNet = '101.00';
        },
        (b) => {
          b.invoice!.documentCharge!.net = '100.00';
        },
        (b) => {
          b.invoice!.documentCharge!.items[0].amount = '9.00';
        },
        (b) => {
          b.invoice!.documentCharge!.items[0].sourceIndex = discount ? 0 : 1;
        },
        (b) => {
          b.invoice!.documentCharge!.items[0].reason = 'A forged explanation of another charge';
        },
        (b) => {
          b.invoice!.documentCharge!.items[0].reasonCode = 'ZZ';
        },
        (b) => {
          b.invoice!.documentCharge!.items.push({ ...b.invoice!.documentCharge!.items[0] });
        },
        (b) => {
          b.lines[0].account = '627';
        },
        (b) => {
          b.lines[0].debit = discount ? '80.00' : '100.00';
          b.lines[1].credit = discount ? '98.90' : '123.10';
        },
      ];
    if (discount)
      mutations.push((b) => {
        Reflect.deleteProperty(b.invoice!, 'documentAllowance');
      });
    for (const mutate of mutations)
      await expect(
        raw(f, base, mutate).catch((error) => {
          throw error.cause ?? error;
        }),
      ).rejects.toThrow('invalid_document_allowance');
    await execute(f, p);
    expect(
      await db.orm
        .select()
        .from(invoicePostings)
        .where(eq(invoicePostings.companyId, f.company.id)),
    ).toHaveLength(1);
  },
);

test('stale approvals and swapped source reasons cannot post after historical facts change', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await charged(f),
    p = await service.invoices.propose(f.actor, key(), {
      ...postingInput(f, a.invoice.id),
      ...classification,
    });
  await service.books.approve(f.actor, key(), p.id, review(p));
  await service.foundation.recordRegime(f.actor, key(), {
    axis: 'vat',
    value: 'normal_vat',
    effectiveFrom: '2026-09-01',
    evidenceId: f.proof.id,
  });
  await expect(
    service.ledger.post(f.actor, key(), { id: p.id, ...review(p) }),
  ).rejects.toMatchObject({ code: 'STALE_INVOICE_TREATMENT' });
  const changed = chargeInvoiceXml({ number: a.invoice.body.number }).replace(
    'Configurare suplimentară a serviciului',
    'Another retained source would be a conflict',
  );
  await expect(importXml(f, {}, changed)).rejects.toMatchObject({
    code: 'INVOICE_SOURCE_CONFLICT',
  });
  expect(
    await db.orm.select().from(journals).where(eq(journals.companyId, f.company.id)),
  ).toHaveLength(0);
});

test('charge percentages, code-only reasons, cent rounding and large exact amounts remain source-derived', async () => {
  const f = await fixture(2026, 'normal_vat'),
    xml = chargeInvoiceXml({ number: key() })
      .replace(
        '<cbc:Amount currencyID="RON">10.00</cbc:Amount>',
        '<cbc:MultiplierFactorNumeric>10</cbc:MultiplierFactorNumeric><cbc:Amount currencyID="RON">10.00</cbc:Amount><cbc:BaseAmount currencyID="RON">100.00</cbc:BaseAmount>',
      )
      .replace(/<cbc:AllowanceChargeReason>[\s\S]*?<\/cbc:AllowanceChargeReason>/, ''),
    a = await importXml(f, {}, xml),
    p = await service.invoices.propose(f.actor, key(), {
      ...postingInput(f, a.invoice.id),
      ...classification,
    });
  expect(generalBodySchema.parse(p.body).invoice!.documentCharge!.items[0]).toMatchObject({
    reason: null,
    reasonCode: 'AAH',
    amount: '10.00',
  });
  await execute(f, p);
  const large = await charged(f, {
      lineNet: '1000000000000000.05',
      allowance: '200000000000000.01',
      charge: '100000000000000.01',
      net: '900000000000000.05',
      tax: '189000000000000.01',
      gross: '1089000000000000.06',
    }),
    big = await service.invoices.propose(f.actor, key(), {
      ...postingInput(f, large.invoice.id),
      ...both,
    });
  await execute(f, big);
  expect(generalBodySchema.parse(big.body).lines[0].debit).toBe('900000000000000.05');
  const small = await charged(f, {
      lineNet: '0.03',
      allowance: '0.01',
      charge: '0.01',
      net: '0.03',
      tax: '0.01',
      gross: '0.04',
    }),
    tiny = await service.invoices.propose(f.actor, key(), {
      ...postingInput(f, small.invoice.id),
      ...both,
    });
  await execute(f, tiny);
  expect(generalBodySchema.parse(tiny.body).invoice).toMatchObject({
    net: '0.03',
    tax: '0.01',
    gross: '0.04',
    documentCharge: { total: '0.01', allowances: '0.01' },
  });
});

async function statement(
  f: Fixture,
  month: '2025-07' | '2025-08',
  opening: string,
  closing: string,
  row: string,
) {
  const source = await service.documents.record(f.actor, key(), {
    filename: `${key()}.csv`,
    mediaType: 'text/csv',
    bytes: Buffer.from(`movement_id,booking_date,amount,currency,reference\n${row}\n`),
  });
  await service.bank.importStatement(f.actor, key(), {
    evidenceId: source.id,
    bankAccount: 'RO00CHARGES',
    statementId: key(),
    from: `${month}-01`,
    to: `${month}-31`,
    opening,
    closing,
  });
  return (await service.queries.movements(f.actor, { matched: false })).items[0];
}

test.each(['purchase', 'sale'] as const)(
  '%s: a charged and discounted invoice can be paid, closed, credited and refunded at its original rate',
  async (direction) => {
    const f = await fixture(2025, 'normal_vat'),
      purchase = direction === 'purchase';
    await execute(
      f,
      await service.ledger.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        evidenceId: f.proof.id,
        date: '2025-01-01',
        purpose: 'opening',
        description: 'Documented opening',
        sourceReference: 'opening',
        lines: [
          { account: '5121', debit: '1000.00', credit: '0.00' },
          { account: '1012', debit: '0.00', credit: '1000.00' },
        ],
      }),
    );
    const a = await charged(f, {
        direction,
        date: '2025-07-01',
        rate: '19',
        allowance: '20.00',
        net: '90.00',
        tax: '17.10',
        gross: '107.10',
      }),
      original = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id, '2025-07-01', direction, purchase ? 'full' : 'none'),
        ...both,
      });
    await execute(f, original);
    const paidClosing = purchase ? '892.90' : '1107.10',
      movement = await statement(
        f,
        '2025-07',
        '1000.00',
        paidClosing,
        `PAY,2025-07-10,${purchase ? '-' : ''}107.10,RON,Service invoice payment`,
      );
    await execute(
      f,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        movementId: movement.id,
        allocations: [{ invoiceId: a.invoice.id, amount: '107.10' }],
      }),
    );
    await service.periods.close(f.actor, key(), '2025-07-01');
    const closed = await service.ledger.balance(f.actor, {
        financialYearId: f.financialYear.id,
        to: '2025-07-31',
      }),
      credit = await importXml(f, {
        number: key(),
        credit: true,
        direction,
        date: '2025-08-01',
        originalNumber: a.invoice.body.number,
        rate: '19',
        net: '10.00',
        tax: '1.90',
        gross: '11.90',
      }),
      p = await service.invoices.proposeCreditNote(f.actor, key(), {
        financialYearId: f.financialYear.id,
        invoiceId: credit.invoice.id,
        originalInvoiceId: a.invoice.id,
        recognitionDate: '2025-08-01',
        decisionDate: '2025-08-01',
        treatmentEvidenceId: f.proof.id,
        kind: 'commercial_discount',
        periodBasis: 'current_period_event',
        reason:
          'A separately documented new concession preserves the original service charge and allowance',
      });
    expect(generalBodySchema.parse(p.body).invoice!.documentCharge).toBeUndefined();
    expect(generalBodySchema.parse(p.body).invoice!.documentAllowance).toBeUndefined();
    await execute(f, p);
    const finalClosing = purchase ? '904.80' : '1095.20',
      refund = await statement(
        f,
        '2025-08',
        paidClosing,
        finalClosing,
        `REF,2025-08-10,${purchase ? '' : '-'}11.90,RON,Current concession refund`,
      );
    await execute(
      f,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        movementId: refund.id,
        allocations: [{ invoiceId: a.invoice.id, amount: '-11.90' }],
      }),
    );
    await service.periods.close(f.actor, key(), '2025-08-01');
    expect(
      await service.ledger.balance(f.actor, {
        financialYearId: f.financialYear.id,
        to: '2025-07-31',
      }),
    ).toEqual(closed);
    expect(await service.invoices.get(f.actor, a.invoice.id)).toEqual(a.invoice);
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({
      status: 'reconciled',
      totals: { inputTax: purchase ? '15.20' : '0.00', outputTax: purchase ? '0.00' : '15.20' },
    });
    expect(
      await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2025-08-31' }),
    ).toMatchObject({ balance: '0.00' });
    const balances = Object.fromEntries(
      (await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id })).balances.map(
        (row) => [row.account, row.closing],
      ),
    );
    expect(balances['5121']).toBe(finalClosing);
    expect(balances[purchase ? '628' : '704']).toBe(purchase ? '90.00' : '-90.00');
    expect(balances[purchase ? '609' : '709']).toBe(purchase ? '-10.00' : '10.00');
  },
);

test('official MCP prepares charges with discounts and retains human authority on execution and cached retries', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await charged(f, {
      direction: 'sale',
      allowance: '20.00',
      net: '90.00',
      tax: '18.90',
      gross: '108.90',
    }),
    request = { ...postingInput(f, a.invoice.id, '2026-10-01', 'sale', 'none'), ...both },
    grant = await service.agents.issue(f.actor, key(), {
      name: 'Service charge assistant',
      scopes: ['invoices.get', 'invoices.propose', 'ledger.post'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    publicUrl = 'http://localhost:3000',
    app = createApp(service, { publicUrl, authSecret: secret }).app,
    client = new Client(
      { name: 'invoice-charge-contract', version: '1' },
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
    expect((await client.listTools()).tools.map((row) => row.name)).not.toContain('books.approve');
    const source = invoiceOutput.parse(
      (await invoke('invoices.get', { id: a.invoice.id })).structuredContent,
    );
    expect(source.body.documentAdjustments!.map((row) => row.charge)).toEqual([false, true]);
    const rejected = await invoke('invoices.propose', {
      ...postingInput(f, a.invoice.id, '2026-10-01', 'sale', 'none'),
      documentAllowance: 'commercial_price_reduction',
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain('INVOICE_CHARGE_TREATMENT');
    const p = proposalOutput.parse((await invoke('invoices.propose', request)).structuredContent);
    expect(generalBodySchema.parse(p.body).invoice!.documentCharge).toMatchObject({
      total: '10.00',
      allowances: '20.00',
      net: '90.00',
    });
    expect((await invoke('ledger.post', { id: p.id, ...review(p) })).isError).toBe(true);
    await service.books.approve(f.actor, key(), p.id, review(p));
    const executionKey = key();
    expect(
      (await invoke('ledger.post', { id: p.id, ...review(p) }, executionKey)).isError,
    ).not.toBe(true);
    await service.agents.revoke(f.actor, key(), grant.id);
    await expect(invoke('ledger.post', { id: p.id, ...review(p) }, executionKey)).rejects.toThrow();
  } finally {
    await client.close();
  }
});

test('charge reasons, combined price, approvals and native guards survive export and fresh restore', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await charged(f, { allowance: '20.00', net: '90.00', tax: '18.90', gross: '108.90' }),
    p = await service.invoices.propose(f.actor, key(), {
      ...postingInput(f, a.invoice.id),
      ...both,
    }),
    executionKey = key(),
    posted = await execute(f, p, executionKey),
    objects = new LocalObjectStore(join(directory, 'objects')),
    job = await service.exports.request(f.actor, key());
  await runOneExport(db, objects);
  const data = JSON.parse(
    Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
  ).data;
  expect(data.invoiceDocuments[0].body.documentAdjustments[1]).toMatchObject({
    charge: true,
    amount: '10.00',
  });
  expect(
    data.proposals.find((row: { id: string }) => row.id === p.id).body.invoice.documentCharge
      .items[0].reason,
  ).toBe('Configurare suplimentară a serviciului');
  await backup(db, objects, join(directory, 'charge-backup'));
  const restored = await restore(
      join(directory, 'charge-backup'),
      join(directory, 'charge-restored'),
    ),
    copyDb = new Database(restored.databaseUrl);
  try {
    await migrate(copyDb);
    const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
    expect(await copy.invoices.get(f.actor, a.invoice.id)).toEqual(a.invoice);
    expect(await copy.ledger.post(f.actor, executionKey, { id: p.id, ...review(p) })).toEqual(
      posted,
    );
    expect((await copy.documents.read(f.actor, a.source.id)).bytes).toEqual(
      (await service.documents.read(f.actor, a.source.id)).bytes,
    );
    expect((await copy.vat.summary(f.actor, { financialYearId: f.financialYear.id })).status).toBe(
      'reconciled',
    );
    await expect(
      copyDb.orm
        .delete(invoiceDocuments)
        .where(eq(invoiceDocuments.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    expect(
      (
        await copyDb.client.execute(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='acc_guard_document_allowance'",
        )
      ).rows[0].sql,
    ).toContain('documentCharge.items');
    expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
  } finally {
    await copyDb.close();
  }
});
