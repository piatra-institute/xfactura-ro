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
  invoiceDocuments,
  invoicePostings,
  invoiceArchives,
} from '../../source/accounting/schema';
import { postJournal } from '../../source/accounting/ledger';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceZip } from './fixtures/archive';
import { chargeInvoiceXml } from './fixtures/invoice-charge';
import { negativeInvoiceXml } from './fixtures/negative-invoice';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const secret = 'synthetic-negative-invoice-secret-at-least-32-characters';
const key = () => randomUUID();
const review = (proposal: { version: number; hash: string }) => ({
  version: proposal.version,
  hash: proposal.hash,
});
let directory: string, db: Database, service: Accounting, ownerId: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-negative-invoices-'));
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
      email: 'negative-invoices@example.test',
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
async function credit(
  f: Fixture,
  original: { id: string; body: { number: string; issueDate: string } },
  xml: Parameters<typeof negativeInvoiceXml>[0] = {},
  kind: 'commercial_discount' | 'cancellation' = 'cancellation',
) {
  const date = xml.date ?? '2026-11-01',
    document = await importXml(
      f,
      {},
      negativeInvoiceXml({
        number: key(),
        originalNumber: original.body.number,
        originalDate: original.body.issueDate,
        ...xml,
      }),
    ),
    request = {
      financialYearId: f.financialYear.id,
      invoiceId: document.invoice.id,
      originalInvoiceId: original.id,
      recognitionDate: date,
      decisionDate: date,
      treatmentEvidenceId: f.proof.id,
      kind,
      periodBasis: 'current_period_event',
      reason:
        'A documented current event reduces the original service through a negative type-380 invoice',
    },
    proposal = await service.invoices.proposeCreditNote(f.actor, key(), request);
  return { ...document, request, proposal };
}
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
  await expect(
    service.ledger.post(f.actor, key(), { id: proposal.id, ...review(proposal) }),
  ).rejects.toThrow();
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

describe('negative type-380 invoices as source-linked credits', () => {
  for (const kind of ['cancellation', 'commercial_discount'] as const)
    test.each([
      {
        year: 2025,
        date: '2025-07-01',
        creditDate: '2025-08-01',
        vat: 'normal_vat',
        direction: 'purchase',
        deduction: 'full',
        category: 'S',
        rate: '19',
        tax: '19.00',
        gross: '119.00',
        creditTax: '3.80',
        creditGross: '23.80',
      },
      {
        year: 2025,
        date: '2025-07-01',
        creditDate: '2025-08-01',
        vat: 'normal_vat',
        direction: 'sale',
        deduction: 'none',
        category: 'S',
        rate: '19',
        tax: '19.00',
        gross: '119.00',
        creditTax: '3.80',
        creditGross: '23.80',
      },
      {
        year: 2026,
        date: '2026-10-01',
        creditDate: '2026-11-01',
        vat: 'normal_vat',
        direction: 'purchase',
        deduction: 'full',
        category: 'S',
        rate: '21',
        tax: '21.00',
        gross: '121.00',
        creditTax: '4.20',
        creditGross: '24.20',
      },
      {
        year: 2026,
        date: '2026-10-01',
        creditDate: '2026-11-01',
        vat: 'normal_vat',
        direction: 'purchase',
        deduction: 'none',
        category: 'S',
        rate: '21',
        tax: '21.00',
        gross: '121.00',
        creditTax: '4.20',
        creditGross: '24.20',
      },
      {
        year: 2026,
        date: '2026-10-01',
        creditDate: '2026-11-01',
        vat: 'normal_vat',
        direction: 'sale',
        deduction: 'none',
        category: 'S',
        rate: '21',
        tax: '21.00',
        gross: '121.00',
        creditTax: '4.20',
        creditGross: '24.20',
      },
      {
        year: 2026,
        date: '2026-10-01',
        creditDate: '2026-11-01',
        vat: 'non_vat',
        direction: 'purchase',
        deduction: 'none',
        category: 'S',
        rate: '21',
        tax: '21.00',
        gross: '121.00',
        creditTax: '4.20',
        creditGross: '24.20',
      },
      {
        year: 2026,
        date: '2026-10-01',
        creditDate: '2026-11-01',
        vat: 'non_vat',
        direction: 'purchase',
        deduction: 'none',
        category: 'O',
        rate: '0',
        tax: '0.00',
        gross: '100.00',
        creditTax: '0.00',
        creditGross: '20.00',
      },
      {
        year: 2026,
        date: '2026-10-01',
        creditDate: '2026-11-01',
        vat: 'non_vat',
        direction: 'sale',
        deduction: 'none',
        category: 'O',
        rate: '0',
        tax: '0.00',
        gross: '100.00',
        creditTax: '0.00',
        creditGross: '20.00',
      },
    ] as const)(
      `$year $vat $direction $deduction: ${kind} preserves source signs and the original VAT`,
      async (c) => {
        const f = await fixture(c.year, c.vat),
          a = await importXml(f, {
            number: key(),
            direction: c.direction,
            date: c.date,
            category: c.category,
            rate: c.rate,
            tax: c.tax,
            gross: c.gross,
          }),
          original = await service.invoices.propose(
            f.actor,
            key(),
            postingInput(f, a.invoice.id, c.date, c.direction, c.deduction),
          );
        await execute(f, original);
        const n = await credit(
            f,
            a.invoice,
            {
              direction: c.direction,
              date: c.creditDate,
              category: c.category,
              rate: c.rate,
              tax: c.creditTax,
              gross: c.creditGross,
            },
            kind,
          ),
          body = generalBodySchema.parse(n.proposal.body),
          purchase = c.direction === 'purchase',
          account =
            kind === 'commercial_discount' ? (purchase ? '609' : '709') : purchase ? '628' : '704',
          cost = purchase && c.deduction === 'none' ? c.creditGross : '20.00';
        expect(n.invoice.body).toMatchObject({
          parserVersion: 'ubl-invoice-4',
          documentType: 'credit_note',
          invoiceTypeCode: '380',
          totals: { net: '20.00', tax: c.creditTax, gross: c.creditGross },
          sourceInvoice: {
            typeCode: '380',
            polarity: 'negative',
            lines: [
              {
                lineId: '1',
                quantity: '-1',
                unitCode: 'HUR',
                unitPrice: '20',
                priceBaseQuantity: '1',
              },
            ],
          },
        });
        expect(body.invoice!.sourceCredit).toEqual({
          schemaVersion: 1,
          typeCode: '380',
          net: '-20.00',
          tax: c.creditTax === '0.00' ? '0.00' : `-${c.creditTax}`,
          gross: `-${c.creditGross}`,
        });
        expect(body.lines).toEqual(
          purchase
            ? [
                { account: '401', debit: c.creditGross, credit: '0.00' },
                { account, debit: '0.00', credit: cost },
                ...(c.deduction === 'full'
                  ? [{ account: '4426', debit: '0.00', credit: c.creditTax }]
                  : []),
              ]
            : [
                { account: '4111', debit: '0.00', credit: c.creditGross },
                { account, debit: '20.00', credit: '0.00' },
                ...(c.creditTax === '0.00'
                  ? []
                  : [{ account: '4427', debit: c.creditTax, credit: '0.00' }]),
              ],
        );
        await expect(
          service.ledger.post(f.actor, key(), { id: n.proposal.id, ...review(n.proposal) }),
        ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
        await execute(f, n.proposal);
        const remainingTax = c.rate === '19' ? '15.20' : c.rate === '21' ? '16.80' : '0.00';
        expect(
          await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
        ).toMatchObject({
          status: 'reconciled',
          totals: {
            inputTax: purchase && c.deduction === 'full' ? remainingTax : '0.00',
            outputTax: purchase ? '0.00' : remainingTax,
          },
        });
        const remaining = c.rate === '19' ? '95.20' : c.rate === '21' ? '96.80' : '80.00';
        expect(
          await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: c.creditDate }),
        ).toMatchObject({ balance: remaining });
        expect(await service.invoices.get(f.actor, a.invoice.id)).toEqual(a.invoice);
      },
    );
});

describe('negative source meaning and identity', () => {
  test('a balanced mixture of positive and negative lines is not a simple storno', () => {
    const xml = negativeInvoiceXml(),
      line = xml.match(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/)![0],
      negative = line.replace('>-20.00<', '>-30.00<').replace('>20.00<', '>30.00<'),
      positive = line
        .replace('<cbc:ID>1<', '<cbc:ID>2<')
        .replace('HUR">-1<', 'HUR">1<')
        .replace('>-20.00<', '>10.00<')
        .replace('>20.00<', '>10.00<');
    expect(() => parseInvoiceXml(Buffer.from(xml.replace(line, negative + positive)))).toThrow();
  });
  test.each([
    ['positive tax', (s: string) => s.replaceAll('>-4.20<', '>4.20<')],
    ['positive gross', (s: string) => s.replaceAll('>-24.20<', '>24.20<')],
    ['positive quantity', (s: string) => s.replace('HUR">-1<', 'HUR">1<')],
    [
      'negative price',
      (s: string) =>
        s.replace('PriceAmount currencyID="RON">20.00<', 'PriceAmount currencyID="RON">-20.00<'),
    ],
    [
      'wrong price',
      (s: string) =>
        s.replace('PriceAmount currencyID="RON">20.00<', 'PriceAmount currencyID="RON">19.99<'),
    ],
    ['quantity precision', (s: string) => s.replace('HUR">-1<', 'HUR">-1.0000001<')],
    [
      'price precision',
      (s: string) =>
        s.replace(
          'PriceAmount currencyID="RON">20.00<',
          'PriceAmount currencyID="RON">20.000000001<',
        ),
    ],
    [
      'price currency',
      (s: string) => s.replace('PriceAmount currencyID="RON"', 'PriceAmount currencyID="EUR"'),
    ],
    [
      'base unit',
      (s: string) =>
        s.replace(
          '</cac:Price>',
          '<cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity></cac:Price>',
        ),
    ],
    [
      'zero base',
      (s: string) =>
        s.replace(
          '</cac:Price>',
          '<cbc:BaseQuantity unitCode="HUR">0</cbc:BaseQuantity></cac:Price>',
        ),
    ],
    [
      'missing original date',
      (s: string) => s.replace('<cbc:IssueDate>2026-10-01</cbc:IssueDate>', ''),
    ],
    [
      'multiple originals',
      (s: string) =>
        s.replace(
          '</cac:BillingReference>',
          '</cac:BillingReference><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>OTHER</cbc:ID><cbc:IssueDate>2026-10-01</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>',
        ),
    ],
    [
      'global adjustment',
      (s: string) =>
        s.replace('<cac:LegalMonetaryTotal>', '<cac:AllowanceCharge/><cac:LegalMonetaryTotal>'),
    ],
    ['line adjustment', (s: string) => s.replace('<cac:Item>', '<cac:AllowanceCharge/><cac:Item>')],
    [
      'price adjustment',
      (s: string) => s.replace('</cac:Price>', '<cac:AllowanceCharge/></cac:Price>'),
    ],
    [
      'prepayment',
      (s: string) =>
        s.replace(
          '</cac:LegalMonetaryTotal>',
          '<cbc:PrepaidAmount currencyID="RON">-1.00</cbc:PrepaidAmount></cac:LegalMonetaryTotal>',
        ),
    ],
    [
      'rounding',
      (s: string) =>
        s.replace(
          '</cac:LegalMonetaryTotal>',
          '<cbc:PayableRoundingAmount currencyID="RON">-0.01</cbc:PayableRoundingAmount></cac:LegalMonetaryTotal>',
        ),
    ],
    ['negative advance type', (s: string) => s.replace('TypeCode>380<', 'TypeCode>386<')],
  ] as const)('%s cannot be normalized into a supported credit', (_name, mutate) => {
    expect(() => parseInvoiceXml(Buffer.from(mutate(negativeInvoiceXml())))).toThrow();
  });

  test('fractional quantities, price bases and half-bani rounding retain exact signed meaning', () => {
    const xml = negativeInvoiceXml({ net: '0.01', tax: '0.00', gross: '0.01' })
        .replace('HUR">-1<', 'HUR">-0.000001<')
        .replace(
          'PriceAmount currencyID="RON">0.01<',
          'PriceAmount currencyID="RON">15000.00000000<',
        )
        .replace(
          '</cac:Price>',
          '<cbc:BaseQuantity unitCode="HUR">3</cbc:BaseQuantity></cac:Price>',
        ),
      parsed = parseInvoiceXml(Buffer.from(xml));
    expect(parsed.totals.net).toBe('0.01');
    expect(parsed.sourceInvoice!.lines[0]).toMatchObject({
      quantity: '-0.000001',
      unitPrice: '15000',
      priceBaseQuantity: '3',
    });
    expect(() =>
      parseInvoiceXml(Buffer.from(xml.replace('>15000.00000000<', '>14999.99999999<'))),
    ).toThrow();
    const tinyPrice = negativeInvoiceXml({ net: '0.01', tax: '0.00', gross: '0.01' })
      .replace('HUR">-1<', 'HUR">-1000000<')
      .replace('PriceAmount currencyID="RON">0.01<', 'PriceAmount currencyID="RON">0.00000001<');
    expect(parseInvoiceXml(Buffer.from(tinyPrice)).sourceInvoice!.lines[0].unitPrice).toBe(
      '0.00000001',
    );
    expect(() =>
      parseInvoiceXml(
        Buffer.from(invoiceXml({ credit: true, net: '-20.00', tax: '-4.20', gross: '-24.20' })),
      ),
    ).toThrow();
  });

  test('formatting reimports are idempotent; changing signed quantity/price or invoice polarity conflicts', async () => {
    const f = await fixture(),
      number = key(),
      xml = negativeInvoiceXml({ number }),
      a = await importXml(f, {}, xml),
      same = await importXml(f, {}, xml.replaceAll('><', '>\n<'));
    expect(same.invoice).toEqual(a.invoice);
    await expect(
      importXml(
        f,
        {},
        xml
          .replace('HUR">-1<', 'HUR">-2<')
          .replace('PriceAmount currencyID="RON">20.00<', 'PriceAmount currencyID="RON">10.00<'),
      ),
    ).rejects.toMatchObject({ code: 'INVOICE_SOURCE_CONFLICT' });
    await expect(importXml(f, { number, date: '2026-11-01' })).rejects.toMatchObject({
      code: 'INVOICE_SOURCE_CONFLICT',
    });
    const positive = await importXml(f, { number: key(), date: '2026-11-01' });
    await expect(
      importXml(f, {}, negativeInvoiceXml({ number: positive.invoice.body.number })),
    ).rejects.toMatchObject({ code: 'INVOICE_SOURCE_CONFLICT' });
  });

  test.each([false, true])(
    '380/381 duplicate credits fail before retention, archived=%s',
    async (archive) => {
      for (const reversed of [false, true]) {
        const f = await fixture(),
          number = key(),
          representations = [
            negativeInvoiceXml({ number }),
            invoiceXml({
              credit: true,
              number,
              date: '2026-11-01',
              net: '20.00',
              tax: '4.20',
              gross: '24.20',
            }),
          ];
        if (reversed) representations.reverse();
        if (archive) {
          const root = await service.documents.record(f.actor, key(), {
            filename: 'conflicting-credit.zip',
            mediaType: 'application/zip',
            bytes: invoiceZip({
              'first.xml': representations[0],
              'second.xml': representations[1],
            }),
          });
          await expect(
            service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id }),
          ).rejects.toMatchObject({ code: 'INVOICE_SOURCE_CONFLICT' });
          expect(
            await db.orm
              .select()
              .from(invoiceArchives)
              .where(eq(invoiceArchives.companyId, f.company.id)),
          ).toHaveLength(0);
          expect(
            await db.orm
              .select()
              .from(invoiceDocuments)
              .where(eq(invoiceDocuments.companyId, f.company.id)),
          ).toHaveLength(0);
          expect(
            await db.orm.select().from(evidence).where(eq(evidence.companyId, f.company.id)),
          ).toHaveLength(2);
        } else {
          await importXml(f, {}, representations[0]);
          await expect(importXml(f, {}, representations[1])).rejects.toMatchObject({
            code: 'INVOICE_SOURCE_CONFLICT',
          });
          expect(
            await db.orm
              .select()
              .from(invoiceDocuments)
              .where(eq(invoiceDocuments.companyId, f.company.id)),
          ).toHaveLength(1);
        }
      }
    },
  );
});

test('original date, VAT rate, company and economic treatment are checked before approval', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await importXml(f, { number: key() }),
    original = await service.invoices.propose(f.actor, key(), postingInput(f, a.invoice.id));
  await execute(f, original);
  await expect(credit(f, a.invoice, { originalDate: '2026-10-02' })).rejects.toMatchObject({
    code: 'CREDIT_ORIGIN',
  });
  await expect(credit(f, a.invoice, { originalNumber: 'WRONG-ORIGIN' })).rejects.toMatchObject({
    code: 'CREDIT_ORIGIN',
  });
  await expect(
    credit(f, a.invoice, { rate: '19', tax: '3.80', gross: '23.80' }),
  ).rejects.toMatchObject({ code: 'CREDIT_VAT_RATE' });
  const n = await credit(f, a.invoice),
    other = await fixture(2026, 'normal_vat');
  await expect(
    service.invoices.proposeCreditNote(other.actor, key(), n.request),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    service.invoices.propose(f.actor, key(), postingInput(f, n.invoice.id, '2026-11-01')),
  ).rejects.toThrow();
  const positiveCorrection = await importXml(
    f,
    {},
    invoiceXml({ number: key(), date: '2026-11-01' }).replace(
      '<cac:LegalMonetaryTotal>',
      `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${n.invoice.body.number}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference><cac:LegalMonetaryTotal>`,
    ),
  );
  await expect(
    service.invoices.propose(
      f.actor,
      key(),
      postingInput(f, positiveCorrection.invoice.id, '2026-11-01'),
    ),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_REFERENCE_TREATMENT' });
  await expect(
    raw(f, generalBodySchema.parse(original.body), (b) => {
      b.date = '2026-11-01';
      b.evidenceId = positiveCorrection.source.id;
      b.sourceReference = `invoice:${positiveCorrection.invoice.id}`;
      b.invoice!.invoiceId = positiveCorrection.invoice.id;
      b.invoice!.invoiceHash = positiveCorrection.invoice.hash;
    }).catch((error) => {
      throw error.cause ?? error;
    }),
  ).rejects.toThrow('unsupported_invoice_reference');
});

test('a full storno above JS safe integer precision clears exactly the original balance and VAT', async () => {
  const f = await fixture(2026, 'normal_vat'),
    amounts = {
      net: '900719925474099.33',
      tax: '189151184349560.86',
      gross: '1089871109823660.19',
    },
    a = await importXml(f, { number: key(), ...amounts });
  await execute(f, await service.invoices.propose(f.actor, key(), postingInput(f, a.invoice.id)));
  const n = await credit(f, a.invoice, amounts);
  expect(generalBodySchema.parse(n.proposal.body).invoice!.sourceCredit).toMatchObject({
    net: '-900719925474099.33',
    tax: '-189151184349560.86',
    gross: '-1089871109823660.19',
  });
  await execute(f, n.proposal);
  expect(
    await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2026-11-30' }),
  ).toMatchObject({ balance: '0.00' });
  expect(await service.vat.summary(f.actor, { financialYearId: f.financialYear.id })).toMatchObject(
    { status: 'reconciled', totals: { inputTax: '0.00', outputTax: '0.00' } },
  );
});

test.each(['purchase', 'sale'] as const)(
  '%s signed source proof and exact reversal are guarded directly in SQLite',
  async (direction) => {
    const f = await fixture(2026, 'normal_vat'),
      a = await importXml(f, { number: key(), direction });
    await execute(
      f,
      await service.invoices.propose(
        f.actor,
        key(),
        postingInput(
          f,
          a.invoice.id,
          '2026-10-01',
          direction,
          direction === 'purchase' ? 'full' : 'none',
        ),
      ),
    );
    const n = await credit(f, a.invoice, { direction }),
      base = generalBodySchema.parse(n.proposal.body);
    const mutations: Array<(b: GeneralBody) => void> = [
      (b) => {
        Reflect.deleteProperty(b.invoice!, 'sourceCredit');
      },
      (b) => {
        b.invoice!.sourceCredit!.net = '20.00';
      },
      (b) => {
        b.invoice!.sourceCredit!.tax = '-4.19';
      },
      (b) => {
        b.invoice!.sourceCredit!.gross = '24.20';
      },
      (b) => {
        b.invoice!.net = '19.00';
      },
      (b) => {
        b.invoice!.deduction = direction === 'purchase' ? 'none' : 'full';
      },
      (b) => {
        b.invoice!.ruleHash = '0'.repeat(64);
      },
      (b) => {
        b.invoice!.invoiceHash = '0'.repeat(64);
      },
      (b) => {
        b.invoice!.credit!.originalFinancialYearId = key();
      },
      (b) => {
        b.invoice!.taxPointDate = '2026-11-01';
      },
      (b) => {
        b.lines[1].account = '627';
      },
      (b) => {
        for (const line of b.lines) [line.debit, line.credit] = [line.credit, line.debit];
      },
    ];
    for (const mutate of mutations)
      await expect(
        raw(f, base, mutate).catch((error) => {
          throw error.cause ?? error;
        }),
      ).rejects.toThrow('invalid_negative_invoice_credit');
    await execute(f, n.proposal);
    expect(
      await db.orm
        .select()
        .from(invoicePostings)
        .where(eq(invoicePostings.companyId, f.company.id)),
    ).toHaveLength(2);
  },
);

test('competing credits invalidate an exact approval and cannot over-credit the original', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await importXml(f, { number: key() });
  await execute(f, await service.invoices.propose(f.actor, key(), postingInput(f, a.invoice.id)));
  const first = await credit(f, a.invoice),
    second = await credit(f, a.invoice);
  await service.books.approve(f.actor, key(), second.proposal.id, review(second.proposal));
  await execute(f, first.proposal);
  await expect(
    service.ledger.post(f.actor, key(), { id: second.proposal.id, ...review(second.proposal) }),
  ).rejects.toThrow();
  const revised = await service.invoices.proposeCreditNote(f.actor, key(), second.request, {
    id: second.proposal.id,
    version: second.proposal.version,
  });
  await expect(
    service.ledger.post(f.actor, key(), { id: revised.id, ...review(revised) }),
  ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  await execute(f, revised);
  await expect(
    credit(f, a.invoice, { net: '61.00', tax: '12.81', gross: '73.81' }),
  ).rejects.toMatchObject({ code: 'OVER_CREDIT' });
  expect(
    await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2026-11-30' }),
  ).toMatchObject({ balance: '72.60' });
});

test.each(['purchase', 'sale'] as const)(
  '%s: paid July books remain closed through an August storno and bank refund at 19%%',
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
    const a = await importXml(
      f,
      {},
      chargeInvoiceXml({
        number: key(),
        direction,
        date: '2025-07-01',
        rate: '19',
        allowance: '20.00',
        net: '90.00',
        tax: '17.10',
        gross: '107.10',
      }),
    );
    await execute(
      f,
      await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id, '2025-07-01', direction, purchase ? 'full' : 'none'),
        documentAllowance: 'commercial_price_reduction',
        documentCharge: 'service_price_component',
      }),
    );
    async function statement(month: '07' | '08', opening: string, closing: string, amount: string) {
      const source = await service.documents.record(f.actor, key(), {
        filename: `${key()}.csv`,
        mediaType: 'text/csv',
        bytes: Buffer.from(
          `movement_id,booking_date,amount,currency,reference\n${key()},2025-${month}-10,${amount},RON,Documented payment\n`,
        ),
      });
      await service.bank.importStatement(f.actor, key(), {
        evidenceId: source.id,
        bankAccount: 'RO00STORNO',
        statementId: key(),
        from: `2025-${month}-01`,
        to: `2025-${month}-31`,
        opening,
        closing,
      });
      return (await service.queries.movements(f.actor, { matched: false })).items[0];
    }
    const paid = purchase ? '892.90' : '1107.10',
      movement = await statement('07', '1000.00', paid, purchase ? '-107.10' : '107.10');
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
      n = await credit(
        f,
        a.invoice,
        { direction, date: '2025-08-01', rate: '19', net: '10.00', tax: '1.90', gross: '11.90' },
        'commercial_discount',
      ),
      treatment = generalBodySchema.parse(n.proposal.body).invoice!;
    expect(treatment.documentAllowance).toBeUndefined();
    expect(treatment.documentCharge).toBeUndefined();
    expect(treatment.sourceCredit).toMatchObject({ net: '-10.00', tax: '-1.90', gross: '-11.90' });
    await execute(f, n.proposal);
    const final = purchase ? '904.80' : '1095.20',
      refund = await statement('08', paid, final, purchase ? '11.90' : '-11.90');
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
    expect(
      await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2025-08-31' }),
    ).toMatchObject({ balance: '0.00' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({
      status: 'reconciled',
      totals: { inputTax: purchase ? '15.20' : '0.00', outputTax: purchase ? '0.00' : '15.20' },
    });
  },
);

test.each([
  { kind: 'advance', direction: 'purchase' },
  { kind: 'advance', direction: 'sale' },
  { kind: 'deferral', direction: 'purchase' },
  { kind: 'deferral', direction: 'sale' },
] as const)(
  '$kind $direction: source encoding retains the dedicated cancellation authority and future balance',
  async ({ kind, direction }) => {
    const f = await fixture(2026, 'normal_vat'),
      a = await importXml(f, { number: key(), direction }),
      account = direction === 'purchase' ? '628' : '704',
      deduction = direction === 'purchase' ? 'full' : 'none',
      common = {
        financialYearId: f.financialYear.id,
        invoiceId: a.invoice.id,
        recognitionDate: '2026-10-01',
        evidenceId: f.proof.id,
        evidenceDate: '2026-10-01',
        account,
        deduction,
        counterpartyVatCollection: 'no',
        reason: 'Retained contract for services beginning in November',
      };
    await execute(
      f,
      kind === 'advance'
        ? await service.advances.proposeInvoice(f.actor, key(), {
            ...common,
            taxPointDate: '2026-10-01',
            reference: 'contract',
            serviceExpectedOn: '2026-12-01',
            paymentIds: [],
          })
        : await service.deferrals.proposeInvoice(f.actor, key(), {
            ...common,
            taxPointBasis: 'early_invoice',
            basis: 'uniform_subscription',
            method: 'equal_calendar_months',
            serviceFrom: '2026-11-01',
            serviceTo: '2026-12-31',
          }),
    );
    const source = await importXml(
        f,
        {},
        negativeInvoiceXml({
          number: key(),
          originalNumber: a.invoice.body.number,
          direction,
          net: '100.00',
          tax: '21.00',
          gross: '121.00',
        }),
      ),
      agreement = await service.documents.record(f.actor, key(), {
        filename: 'cancellation.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('Subsequent signed agreement cancels the undelivered services'),
      }),
      request = {
        financialYearId: f.financialYear.id,
        invoiceId: source.invoice.id,
        originalInvoiceId: a.invoice.id,
        recognitionDate: '2026-11-01',
        decisionDate: '2026-11-01',
        treatmentEvidenceId: agreement.id,
        kind: 'cancellation',
        periodBasis: 'current_period_event',
        reason: 'Documented cancellation before any service is performed',
      };
    await expect(service.invoices.proposeCreditNote(f.actor, key(), request)).rejects.toThrow();
    const p =
      kind === 'advance'
        ? await service.advances.proposeCreditNote(f.actor, key(), request)
        : await service.deferrals.proposeCreditNote(f.actor, key(), {
            ...request,
            cancelFrom: '2026-11-01',
          });
    expect(generalBodySchema.parse(p.body).invoice!.sourceCredit).toMatchObject({
      gross: '-121.00',
    });
    await execute(f, p);
    expect(
      await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2026-11-01' }),
    ).toMatchObject({ balance: '0.00' });
    expect(
      await service.vat.summary(f.actor, { financialYearId: f.financialYear.id }),
    ).toMatchObject({ status: 'reconciled', totals: { inputTax: '0.00', outputTax: '0.00' } });
  },
);

test('official MCP prepares a signed-source correction, requires human approval and rejects revoked cached execution', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await importXml(f, { number: key() });
  await execute(f, await service.invoices.propose(f.actor, key(), postingInput(f, a.invoice.id)));
  const source = await service.documents.record(f.actor, key(), {
      filename: 'storno.xml',
      mediaType: 'application/xml',
      bytes: Buffer.from(
        negativeInvoiceXml({ number: key(), originalNumber: a.invoice.body.number }),
      ),
    }),
    grant = await service.agents.issue(f.actor, key(), {
      name: 'Storno assistant',
      scopes: ['invoices.import', 'invoices.get', 'invoices.proposeCreditNote', 'ledger.post'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    publicUrl = 'http://localhost:3000',
    app = createApp(service, { publicUrl, authSecret: secret }).app,
    client = new Client(
      { name: 'negative-invoice-contract', version: '1' },
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
    const n = invoiceOutput.parse(
      (await invoke('invoices.import', { evidenceId: source.id })).structuredContent,
    );
    expect(n.body.sourceInvoice!.polarity).toBe('negative');
    const p = proposalOutput.parse(
      (
        await invoke('invoices.proposeCreditNote', {
          financialYearId: f.financialYear.id,
          invoiceId: n.id,
          originalInvoiceId: a.invoice.id,
          recognitionDate: '2026-11-01',
          decisionDate: '2026-11-01',
          treatmentEvidenceId: f.proof.id,
          kind: 'cancellation',
          periodBasis: 'current_period_event',
          reason: 'Retained agreement cancels part of the original service',
        })
      ).structuredContent,
    );
    expect(generalBodySchema.parse(p.body).invoice!.sourceCredit!.gross).toBe('-24.20');
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

test('original signed bytes, correction proof, exact approvals and guard survive export and fresh restore', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await importXml(f, { number: key() });
  await execute(f, await service.invoices.propose(f.actor, key(), postingInput(f, a.invoice.id)));
  const n = await credit(f, a.invoice),
    executionKey = key(),
    result = await execute(f, n.proposal, executionKey),
    objects = new LocalObjectStore(join(directory, 'objects')),
    job = await service.exports.request(f.actor, key());
  await runOneExport(db, objects);
  const data = JSON.parse(
    Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
  ).data;
  expect(
    data.invoiceDocuments.find((r: { id: string }) => r.id === n.invoice.id).body.sourceInvoice
      .lines[0].quantity,
  ).toBe('-1');
  expect(
    data.proposals.find((r: { id: string }) => r.id === n.proposal.id).body.invoice.sourceCredit
      .gross,
  ).toBe('-24.20');
  await backup(db, objects, join(directory, 'storno-backup'));
  const restored = await restore(
      join(directory, 'storno-backup'),
      join(directory, 'storno-restored'),
    ),
    copyDb = new Database(restored.databaseUrl);
  try {
    await migrate(copyDb);
    const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
    expect(await copy.invoices.get(f.actor, n.invoice.id)).toEqual(n.invoice);
    expect((await copy.documents.read(f.actor, n.source.id)).bytes).toEqual(
      (await service.documents.read(f.actor, n.source.id)).bytes,
    );
    expect(
      await copy.ledger.post(f.actor, executionKey, { id: n.proposal.id, ...review(n.proposal) }),
    ).toEqual(result);
    expect((await copy.vat.summary(f.actor, { financialYearId: f.financialYear.id })).status).toBe(
      'reconciled',
    );
    await expect(
      copyDb.orm.delete(invoiceDocuments).where(eq(invoiceDocuments.id, n.invoice.id)).execute(),
    ).rejects.toThrow();
    expect(
      (
        await copyDb.client.execute(
          "SELECT sql FROM sqlite_master WHERE name='acc_guard_negative_invoice'",
        )
      ).rows[0].sql,
    ).toContain('invalid_negative_invoice_credit');
    expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
  } finally {
    await copyDb.close();
  }
});
