import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Accounting } from '../../source/accounting/application';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { createAuth } from '../../source/accounting/auth';
import { createApp } from '../../source/accounting/app';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import { parseInvoiceXml } from '../../source/accounting/invoice-document';
import { canonical, generalBodySchema, type GeneralBody } from '../../source/accounting/domain';
import {
  invoiceOutput,
  postingOutput,
  proposalOutput,
  proposalView,
} from '../../source/accounting/capability-contracts';
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
import { allowanceInvoiceXml } from './fixtures/invoice-allowance';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const secret = 'synthetic-invoice-allowance-secret-at-least-32-characters';
const key = () => randomUUID();
const review = (proposal: { version: number; hash: string }) => ({
  version: proposal.version,
  hash: proposal.hash,
});
let directory: string, db: Database, service: Accounting, ownerId: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-invoice-allowances-'));
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
      email: 'invoice-allowances@example.test',
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
async function allowance(f: Fixture, input: Parameters<typeof allowanceInvoiceXml>[0] = {}) {
  return importXml(f, {}, allowanceInvoiceXml({ number: key(), ...input }));
}
const classification = { documentAllowance: 'commercial_price_reduction' as const };
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

describe('commercial allowances on the original service invoice', () => {
  test.each([
    {
      year: 2025,
      date: '2025-07-01',
      vat: 'normal_vat',
      direction: 'purchase',
      deduction: 'full',
      category: 'S',
      rate: '19',
      tax: '15.20',
      gross: '95.20',
      cost: '80.00',
    },
    {
      year: 2025,
      date: '2025-07-01',
      vat: 'normal_vat',
      direction: 'sale',
      deduction: 'none',
      category: 'S',
      rate: '19',
      tax: '15.20',
      gross: '95.20',
      cost: '80.00',
    },
    {
      year: 2026,
      date: '2026-10-01',
      vat: 'normal_vat',
      direction: 'purchase',
      deduction: 'full',
      category: 'S',
      rate: '21',
      tax: '16.80',
      gross: '96.80',
      cost: '80.00',
    },
    {
      year: 2026,
      date: '2026-10-01',
      vat: 'normal_vat',
      direction: 'purchase',
      deduction: 'none',
      category: 'S',
      rate: '21',
      tax: '16.80',
      gross: '96.80',
      cost: '96.80',
    },
    {
      year: 2026,
      date: '2026-10-01',
      vat: 'normal_vat',
      direction: 'sale',
      deduction: 'none',
      category: 'S',
      rate: '21',
      tax: '16.80',
      gross: '96.80',
      cost: '80.00',
    },
    {
      year: 2026,
      date: '2026-10-01',
      vat: 'non_vat',
      direction: 'purchase',
      deduction: 'none',
      category: 'S',
      rate: '21',
      tax: '16.80',
      gross: '96.80',
      cost: '96.80',
    },
    {
      year: 2026,
      date: '2026-10-01',
      vat: 'non_vat',
      direction: 'purchase',
      deduction: 'none',
      category: 'O',
      rate: '0',
      tax: '0.00',
      gross: '80.00',
      cost: '80.00',
    },
    {
      year: 2026,
      date: '2026-10-01',
      vat: 'non_vat',
      direction: 'sale',
      deduction: 'none',
      category: 'O',
      rate: '0',
      tax: '0.00',
      gross: '80.00',
      cost: '80.00',
    },
  ] as const)(
    '$year $vat $direction $deduction: 100 less 20 recognizes only 80 net and its supported VAT',
    async (c) => {
      const f = await fixture(c.year, c.vat),
        a = await allowance(f, c),
        input = {
          ...postingInput(f, a.invoice.id, c.date, c.direction, c.deduction),
          ...classification,
        };
      expect(a.invoice.body).toMatchObject({
        parserVersion: 'ubl-invoice-3',
        documentAdjustments: [
          {
            charge: false,
            amount: '20.00',
            base: '100.00',
            percentage: '20',
            reasonCode: '95',
            vatCategory: c.category,
          },
        ],
        totals: {
          lineNet: '100.00',
          net: '80.00',
          allowances: '20.00',
          tax: c.tax,
          gross: c.gross,
        },
      });
      await expect(
        service.invoices.propose(
          f.actor,
          key(),
          postingInput(f, a.invoice.id, c.date, c.direction, c.deduction),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_TREATMENT' });
      const p = await service.invoices.propose(f.actor, key(), input),
        body = generalBodySchema.parse(p.body);
      expect(body.invoice!.documentAllowance).toEqual({
        schemaVersion: 1,
        kind: 'commercial_price_reduction',
        lineNet: '100.00',
        total: '20.00',
        net: '80.00',
      });
      expect(body.lines).toEqual(
        c.direction === 'purchase'
          ? [
              { account: '628', debit: c.cost, credit: '0.00' },
              { account: '401', debit: '0.00', credit: c.gross },
              ...(c.deduction === 'full'
                ? [{ account: '4426', debit: c.tax, credit: '0.00' }]
                : []),
            ]
          : [
              { account: '4111', debit: c.gross, credit: '0.00' },
              { account: '704', debit: '0.00', credit: '80.00' },
              ...(c.tax === '0.00' ? [] : [{ account: '4427', debit: '0.00', credit: c.tax }]),
            ],
      );
      await expect(
        service.ledger.post(f.actor, key(), { id: p.id, ...review(p) }),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      await execute(f, p);
      const vat = await service.vat.summary(f.actor, { financialYearId: f.financialYear.id });
      expect(vat).toMatchObject({
        status: 'reconciled',
        totals: {
          inputTax: c.direction === 'purchase' && c.deduction === 'full' ? c.tax : '0.00',
          outputTax: c.direction === 'sale' ? c.tax : '0.00',
        },
      });
      expect(
        await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: c.date }),
      ).toMatchObject({ gross: c.gross, balance: c.gross });
      expect((await service.documents.read(f.actor, a.source.id)).bytes).toEqual(
        Buffer.from(allowanceInvoiceXml({ number: a.invoice.body.number, ...c })),
      );
    },
  );

  test('multiple commercial allowances reconcile to one net service basis without floating point loss', async () => {
    const f = await fixture(2026, 'normal_vat'),
      first = allowanceInvoiceXml({}).match(
        /<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/,
      )![0],
      adjustments =
        first.replace('20.00', '10.00').replace('Numeric>20<', 'Numeric>10<') +
        first.replace('20.00', '5.00').replace('Numeric>20<', 'Numeric>5<'),
      a = await allowance(f, {
        allowance: '15.00',
        net: '85.00',
        tax: '17.85',
        gross: '102.85',
        adjustments,
      }),
      p = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...classification,
      });
    await execute(f, p);
    expect(generalBodySchema.parse(p.body).invoice!.documentAllowance).toMatchObject({
      total: '15.00',
      net: '85.00',
    });
    expect(a.invoice.body.documentAdjustments).toHaveLength(2);
  });
});

describe('allowance source validation and authority', () => {
  const xml = allowanceInvoiceXml();
  test.each([
    [
      'missing indicator',
      xml.replace('<cbc:ChargeIndicator>false</cbc:ChargeIndicator>', ''),
      'ChargeIndicator',
    ],
    [
      'ambiguous indicator',
      xml.replace(
        '<cbc:ChargeIndicator>false</cbc:ChargeIndicator>',
        '<cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:ChargeIndicator>true</cbc:ChargeIndicator>',
      ),
      'ChargeIndicator',
    ],
    ['invalid indicator', xml.replace('Indicator>false<', 'Indicator>sometimes<'), 'Indicatorul'],
    [
      'foreign indicator namespace',
      xml.replaceAll('cbc:ChargeIndicator', 'cac:ChargeIndicator'),
      'ChargeIndicator',
    ],
    [
      'missing reason',
      xml
        .replace(/<cbc:AllowanceChargeReasonCode>[\s\S]*?<\/cbc:AllowanceChargeReasonCode>/, '')
        .replace(/<cbc:AllowanceChargeReason>[\s\S]*?<\/cbc:AllowanceChargeReason>/, ''),
      'motivul',
    ],
    [
      'missing allowance currency',
      xml.replace('<cbc:Amount currencyID="RON">', '<cbc:Amount>'),
      'Moneda',
    ],
    [
      'foreign allowance currency',
      xml.replace('<cbc:Amount currencyID="RON">', '<cbc:Amount currencyID="EUR">'),
      'Moneda',
    ],
    [
      'mismatched detail sum',
      xml
        .replace('<cbc:Amount currencyID="RON">20.00', '<cbc:Amount currencyID="RON">10.00')
        .replace('<cbc:MultiplierFactorNumeric>20', '<cbc:MultiplierFactorNumeric>10'),
      'nu se reconciliază',
    ],
    [
      'wrong percentage amount',
      xml.replace('<cbc:MultiplierFactorNumeric>20', '<cbc:MultiplierFactorNumeric>10'),
      'procentului',
    ],
    [
      'percentage without base',
      xml.replace(/<cbc:BaseAmount[^>]*>[\s\S]*?<\/cbc:BaseAmount>/, ''),
      'împreună',
    ],
    [
      'base without percentage',
      xml.replace(/<cbc:MultiplierFactorNumeric>[\s\S]*?<\/cbc:MultiplierFactorNumeric>/, ''),
      'împreună',
    ],
    [
      'non VAT scheme',
      xml.replace('<cac:TaxScheme><cbc:ID>VAT', '<cac:TaxScheme><cbc:ID>GST'),
      'nu este TVA',
    ],
    [
      'duplicate amount',
      xml.replace(
        '<cbc:Amount currencyID="RON">20.00</cbc:Amount>',
        '<cbc:Amount currencyID="RON">20.00</cbc:Amount><cbc:Amount currencyID="RON">20.00</cbc:Amount>',
      ),
      'Amount',
    ],
    [
      'excess details',
      xml.replace(
        /<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/,
        xml.match(/<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/)![0].repeat(101),
      ),
      'Prea multe',
    ],
  ])('rejects %s before retaining invoice facts', async (_name, contents, message) => {
    expect(() => parseInvoiceXml(Buffer.from(contents))).toThrow(message);
    const f = await fixture(2026, 'normal_vat');
    await expect(importXml(f, {}, contents)).rejects.toThrow();
    expect(
      await db.orm
        .select()
        .from(invoiceDocuments)
        .where(eq(invoiceDocuments.companyId, f.company.id)),
    ).toHaveLength(0);
  });

  test('reason-only allowances and lexical boolean variants retain the same supported facts', () => {
    const noCode = xml.replace(
      /<cbc:AllowanceChargeReasonCode>[\s\S]*?<\/cbc:AllowanceChargeReasonCode>/,
      '',
    );
    expect(parseInvoiceXml(Buffer.from(noCode)).documentAdjustments![0]).toMatchObject({
      reason: 'Reducere comercială la facturare',
      reasonCode: null,
    });
    expect(parseInvoiceXml(Buffer.from(xml.replace('Indicator>false<', 'Indicator>0<')))).toEqual(
      parseInvoiceXml(Buffer.from(xml)),
    );
  });

  test('header-only legacy amounts stay retained but cannot authorize an invented allowance breakdown', async () => {
    const f = await fixture(2026, 'normal_vat'),
      a = await allowance(f, { adjustments: '' });
    expect(a.invoice.body.parserVersion).toBe('ubl-invoice-1');
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_DETAILS' });
  });

  test('ordinary invoices reject irrelevant classifications and mixed tax categories remain unsupported', async () => {
    const f = await fixture(2026, 'normal_vat'),
      ordinary = await importXml(f, { number: key() });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, ordinary.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_TREATMENT' });
    const wrongCategory = await importXml(
      f,
      {},
      allowanceInvoiceXml({ number: key() }).replace(
        '<cac:TaxCategory><cbc:ID>S',
        '<cac:TaxCategory><cbc:ID>E',
      ),
    );
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, wrongCategory.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_DETAILS' });
    const wrongRate = await importXml(
      f,
      {},
      allowanceInvoiceXml({ number: key() }).replace(
        '<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>21',
        '<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19',
      ),
    );
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, wrongRate.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_DETAILS' });
  });

  test('allowance semantics cannot hide charges, full-free invoices, advance types or foreign-company sources', async () => {
    const f = await fixture(2026, 'normal_vat'),
      other = await fixture(2026, 'normal_vat'),
      a = await allowance(f);
    await expect(
      service.invoices.propose(other.actor, key(), {
        ...postingInput(other, a.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const advance = await importXml(
      f,
      {},
      allowanceInvoiceXml({ number: key() }).replace(
        'InvoiceTypeCode>380<',
        'InvoiceTypeCode>386<',
      ),
    );
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, advance.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_DETAILS' });
    const free = await allowance(f, {
      allowance: '100.00',
      net: '0.00',
      tax: '0.00',
      gross: '0.00',
      adjustments: allowanceInvoiceXml()
        .match(/<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/)![0]
        .replaceAll('20.00', '100.00')
        .replace('Numeric>20<', 'Numeric>100<'),
    });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, free.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TREATMENT' });
    const chargedXml = invoiceXml({ number: key(), net: '120.00', tax: '25.20', gross: '145.20' })
      .replaceAll(
        'LineExtensionAmount currencyID="RON">120.00',
        'LineExtensionAmount currencyID="RON">100.00',
      )
      .replace(
        '<cac:TaxTotal>',
        allowanceInvoiceXml()
          .match(/<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/)![0]
          .replace('Indicator>false<', 'Indicator>true<') + '<cac:TaxTotal>',
      )
      .replace(
        '<cac:LegalMonetaryTotal>',
        '<cac:LegalMonetaryTotal><cbc:ChargeTotalAmount currencyID="RON">20.00</cbc:ChargeTotalAmount>',
      );
    const charge = await importXml(f, {}, chargedXml);
    expect(charge.invoice.body.documentAdjustments![0].charge).toBe(true);
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, charge.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TREATMENT' });
  });

  test('discounted tax must be independently consistent with the original rate and net basis', async () => {
    const f = await fixture(2026, 'normal_vat'),
      a = await allowance(f, { tax: '21.00', gross: '101.00' });
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...classification,
      }),
    ).rejects.toMatchObject({ code: 'VAT_AMOUNT' });
  });

  test('a historical registration added after approval cannot reuse the prior exact treatment', async () => {
    const f = await fixture(2026, 'normal_vat'),
      a = await allowance(f),
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
    expect(
      await db.orm.select().from(journals).where(eq(journals.companyId, f.company.id)),
    ).toHaveLength(0);
  });

  test('SQLite rejects missing or forged allowance proof and balanced postings of the undiscounted amount', async () => {
    const f = await fixture(2026, 'normal_vat'),
      a = await allowance(f),
      p = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id),
        ...classification,
      }),
      base = generalBodySchema.parse(p.body),
      mutations: Array<(b: GeneralBody) => void> = [
        (b) => {
          Reflect.deleteProperty(b.invoice!, 'documentAllowance');
        },
        (b) => {
          b.invoice!.documentAllowance!.total = '10.00';
        },
        (b) => {
          b.invoice!.documentAllowance!.lineNet = '90.00';
        },
        (b) => {
          b.invoice!.documentAllowance!.net = '100.00';
        },
        (b) => {
          b.lines[0].debit = '100.00';
          b.lines[1].credit = '116.80';
        },
        (b) => {
          b.invoice!.deductibleTax = '21.00';
          b.lines[0].debit = '75.80';
          b.lines[2].debit = '21.00';
        },
        (b) => {
          b.lines[0].account = '609';
        },
        (b) => {
          b.invoice!.net = '100.00';
        },
      ];
    for (const mutation of mutations)
      await expect(
        raw(f, base, mutation).catch((error) => {
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
  });

  test('exact large allowances and a cent-sized rounded allowance keep every ban', async () => {
    const f = await fixture(2026, 'normal_vat'),
      large = await allowance(f, {
        lineNet: '1000000000000000.05',
        allowance: '200000000000000.01',
        net: '800000000000000.04',
        tax: '168000000000000.01',
        gross: '968000000000000.05',
      }),
      p = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, large.invoice.id),
        ...classification,
      });
    await execute(f, p);
    expect(generalBodySchema.parse(p.body).lines[0].debit).toBe('800000000000000.04');
    const tiny = await allowance(f, {
        lineNet: '0.03',
        allowance: '0.01',
        net: '0.02',
        tax: '0.00',
        gross: '0.02',
      }),
      small = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, tiny.invoice.id),
        ...classification,
      });
    await execute(f, small);
    expect(generalBodySchema.parse(small.body).invoice!.documentAllowance).toMatchObject({
      total: '0.01',
      net: '0.02',
    });
  });

  test('ZIP import preserves the detailed source, deduplicates formatting variants and rejects changed reasons atomically', async () => {
    const f = await fixture(2026, 'normal_vat'),
      contents = allowanceInvoiceXml({ number: key() }),
      a = await importXml(f, {}, contents);
    async function archive(files: Record<string, string>) {
      const file = await service.documents.record(f.actor, key(), {
        filename: `${key()}.zip`,
        mediaType: 'application/zip',
        bytes: invoiceZip(files),
      });
      return service.invoiceArchives.import(f.actor, key(), { evidenceId: file.id });
    }
    const result = await archive({ 'factura.xml': contents.replaceAll('><', '>\n<') });
    expect(result.entries[0].invoiceId).toBe(a.invoice.id);
    expect((await service.documents.read(f.actor, result.entries[0].evidenceId)).bytes).toEqual(
      Buffer.from(contents.replaceAll('><', '>\n<')),
    );
    const changed = contents.replace(
      'Reducere comercială la facturare',
      'Alt motiv care nu înlocuiește sursa reținută',
    );
    await expect(
      archive({ 'new.xml': allowanceInvoiceXml({ number: key() }), 'changed.xml': changed }),
    ).rejects.toMatchObject({ code: 'INVOICE_SOURCE_CONFLICT' });
    expect(
      await db.orm
        .select()
        .from(invoiceDocuments)
        .where(eq(invoiceDocuments.companyId, f.company.id)),
    ).toHaveLength(1);
  });
});

async function bankStatement(
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
    bankAccount: 'RO00ALLOWANCES',
    statementId: key(),
    from: `${month}-01`,
    to: `${month}-31`,
    opening,
    closing,
  });
  return (await service.queries.movements(f.actor, { matched: false })).items[0];
}

test.each(['purchase', 'sale'] as const)(
  '%s: paid discounted invoice, later 19 percent credit and refund preserve the closed original month',
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
    const a = await allowance(f, {
        direction,
        date: '2025-07-01',
        rate: '19',
        tax: '15.20',
        gross: '95.20',
      }),
      proposal = await service.invoices.propose(f.actor, key(), {
        ...postingInput(f, a.invoice.id, '2025-07-01', direction, purchase ? 'full' : 'none'),
        ...classification,
      });
    await execute(f, proposal);
    const paidClosing = purchase ? '904.80' : '1095.20',
      movement = await bankStatement(
        f,
        '2025-07',
        '1000.00',
        paidClosing,
        `PAY,2025-07-10,${purchase ? '-' : ''}95.20,RON,Invoice payment`,
      );
    await execute(
      f,
      await service.settlements.propose(f.actor, key(), {
        financialYearId: f.financialYear.id,
        movementId: movement.id,
        allocations: [{ invoiceId: a.invoice.id, amount: '95.20' }],
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
        net: '10.00',
        tax: '1.90',
        gross: '11.90',
        rate: '19',
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
          'A separately documented later commercial concession preserves the original invoice discount',
      });
    expect(generalBodySchema.parse(p.body).invoice!.documentAllowance).toBeUndefined();
    await execute(f, p);
    expect(
      await service.positions.read(f.actor, { invoiceId: a.invoice.id, date: '2025-08-01' }),
    ).toMatchObject({ balance: '-11.90', status: 'refund_due' });
    const finalClosing = purchase ? '916.70' : '1083.30',
      refund = await bankStatement(
        f,
        '2025-08',
        paidClosing,
        finalClosing,
        `REF,2025-08-10,${purchase ? '' : '-'}11.90,RON,Credit refund`,
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
      totals: { inputTax: purchase ? '13.30' : '0.00', outputTax: purchase ? '0.00' : '13.30' },
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
    expect(balances[purchase ? '628' : '704']).toBe(purchase ? '80.00' : '-80.00');
    expect(balances[purchase ? '609' : '709']).toBe(purchase ? '-10.00' : '10.00');
  },
);

test('official MCP prepares the classified discount and waits for a human, including live revocation on cached execution', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await allowance(f, { direction: 'sale' }),
    request = { ...postingInput(f, a.invoice.id, '2026-10-01', 'sale', 'none'), ...classification },
    grant = await service.agents.issue(f.actor, key(), {
      name: 'Discounted invoice assistant',
      scopes: ['invoices.get', 'invoices.propose', 'ledger.post'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    publicUrl = 'http://localhost:3000',
    app = createApp(service, { publicUrl, authSecret: secret }).app,
    client = new Client(
      { name: 'invoice-allowance-contract', version: '1' },
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
    expect(
      invoiceOutput.parse((await invoke('invoices.get', { id: a.invoice.id })).structuredContent)
        .body.documentAdjustments![0].amount,
    ).toBe('20.00');
    const rejected = await invoke(
      'invoices.propose',
      postingInput(f, a.invoice.id, '2026-10-01', 'sale', 'none'),
    );
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain('INVOICE_ALLOWANCE_TREATMENT');
    const p = proposalOutput.parse((await invoke('invoices.propose', request)).structuredContent);
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

test('discount facts, exact approvals, original bytes and native guards survive export and fresh restore', async () => {
  const f = await fixture(2026, 'normal_vat'),
    a = await allowance(f),
    p = await service.invoices.propose(f.actor, key(), {
      ...postingInput(f, a.invoice.id),
      ...classification,
    }),
    executionKey = key(),
    posted = await execute(f, p, executionKey),
    job = await service.exports.request(f.actor, key()),
    objects = new LocalObjectStore(join(directory, 'objects'));
  await runOneExport(db, objects);
  const data = JSON.parse(
    Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
  ).data;
  expect(data.invoiceDocuments[0].body.documentAdjustments[0].amount).toBe('20.00');
  expect(
    data.proposals.find((row: { id: string }) => row.id === p.id).body.invoice.documentAllowance
      .total,
  ).toBe('20.00');
  await backup(db, objects, join(directory, 'allowance-backup'));
  const restored = await restore(
      join(directory, 'allowance-backup'),
      join(directory, 'allowance-restored'),
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
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='acc_guard_document_allowance'",
        )
      ).rows,
    ).toHaveLength(1);
    expect((await copyDb.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
  } finally {
    await copyDb.close();
  }
});
