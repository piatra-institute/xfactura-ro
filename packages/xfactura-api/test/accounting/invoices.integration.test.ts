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
import { LocalObjectStore } from '../../source/accounting/object-store';
import { parseInvoiceXml } from '../../source/accounting/invoice-document';
import { generalBodySchema } from '../../source/accounting/domain';
import {
  invoiceOutput,
  postingOutput,
  proposalOutput,
  proposalView,
} from '../../source/accounting/capability-contracts';
import { accountingPolicies, invoiceDocuments } from '../../source/accounting/schema';
import { invoiceXml, type XmlInput } from './fixtures/invoice';

const secret = 'synthetic-invoice-import-secret-at-least-32-characters';
const key = () => randomUUID();
const review = (proposal: { version: number; hash: string }) => ({
  version: proposal.version,
  hash: proposal.hash,
});
let directory: string, db: Database, service: Accounting, ownerId: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-invoice-import-'));
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
      email: 'invoice@example.test',
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
async function post(f: Fixture, input: ReturnType<typeof postingInput>) {
  const proposal = await service.invoices.propose(f.actor, key(), input);
  const preview = proposalView.parse(
    await service.capabilities.invoke(f.actor, 'proposals.get', key(), { id: proposal.id }),
  );
  await service.books.approve(f.actor, key(), proposal.id, review(proposal));
  await service.ledger.post(f.actor, key(), { id: proposal.id, ...review(proposal) });
  return preview;
}

describe('retained e-Factura XML to reviewed accounting', () => {
  test('an MCP client imports XML, prepares VAT lines and resumes exact posting after human approval', async () => {
    const f = await fixture(2026, 'normal_vat');
    const source = await service.documents.record(f.actor, key(), {
      filename: 'mcp-invoice.xml',
      mediaType: 'application/xml',
      bytes: Buffer.from(invoiceXml()),
    });
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'MCP invoice agent',
      scopes: ['invoices.import', 'invoices.propose', 'ledger.post'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const publicUrl = 'http://localhost:3000';
    const app = createApp(service, { publicUrl, authSecret: secret }).app;
    const transport = new StreamableHTTPClientTransport(
      new URL(`${publicUrl}/api/accounting/v1/companies/${f.company.id}/mcp`),
      {
        authProvider: { token: async () => grant.token },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          request.headers.set('host', new URL(request.url).host);
          return app.fetch(request);
        },
      },
    );
    const client = new Client(
      { name: 'xfactura-invoice-conformance-test', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('invoices.propose');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('ledger.propose');
      const imported = await client.callTool({
        name: 'invoices.import',
        arguments: { input: { evidenceId: source.id }, idempotencyKey: key() },
      });
      const invoice = invoiceOutput.parse(imported.structuredContent);
      const prepared = await client.callTool({
        name: 'invoices.propose',
        arguments: { input: postingInput(f, invoice.id), idempotencyKey: key() },
      });
      const proposal = proposalOutput.parse(prepared.structuredContent);
      expect(generalBodySchema.parse(proposal.body).invoice?.deductibleTax).toBe('21.00');
      const commandKey = key(),
        input = { id: proposal.id, ...review(proposal) };
      const denied = await client.callTool({
        name: 'ledger.post',
        arguments: { input, idempotencyKey: commandKey },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('APPROVAL_REQUIRED');
      await service.books.approve(f.actor, key(), proposal.id, review(proposal));
      const posted = await client.callTool({
        name: 'ledger.post',
        arguments: { input, idempotencyKey: commandKey },
      });
      const entry = postingOutput.parse(posted.structuredContent);
      const retry = await client.callTool({
        name: 'ledger.post',
        arguments: { input, idempotencyKey: commandKey },
      });
      expect(postingOutput.parse(retry.structuredContent)).toEqual(entry);
      expect((await service.overview(f.actor)).journals).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
  test('VAT rounding and cost allocation match independent integer arithmetic across generated amounts', async () => {
    const f = await fixture(2026, 'normal_vat');
    const decimal = (bani: bigint) => `${bani / 100n}.${String(bani % 100n).padStart(2, '0')}`;
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 9007199254740993n }), async (net) => {
        const tax = (net * 21n + 50n) / 100n;
        const xml = invoiceXml({
          number: key(),
          tax: decimal(tax),
          gross: decimal(net + tax),
        }).replaceAll('100.00', decimal(net));
        const { invoice } = await importXml(f, {}, xml);
        const proposal = await service.invoices.propose(
          f.actor,
          key(),
          postingInput(f, invoice.id),
        );
        const body = generalBodySchema.parse(proposal.body);
        expect(body.invoice?.deductibleTax).toBe(decimal(tax));
        expect(body.lines.find((line) => line.account === '628')?.debit).toBe(decimal(net));
        expect(body.lines.find((line) => line.account === '401')?.credit).toBe(decimal(net + tax));
        expect(body.lines.filter((line) => line.account === '4426')).toHaveLength(
          tax === 0n ? 0 : 1,
        );
      }),
      { seed: 20261027, numRuns: 64 },
    );
  });
  for (const example of [
    { year: 2025, date: '2025-01-15', rate: '19', tax: '19.00', gross: '119.00' },
    { year: 2025, date: '2025-08-01', rate: '21', tax: '21.00', gross: '121.00' },
    { year: 2026, date: '2026-10-01', rate: '21', tax: '21.00', gross: '121.00' },
  ])
    test(`generates VAT sales and deductible purchases at the tax point ${example.date}`, async () => {
      const f = await fixture(example.year, 'normal_vat');
      for (const direction of ['sale', 'purchase'] as const) {
        const { invoice } = await importXml(f, { ...example, direction });
        expect(invoice.direction).toBe(direction);
        const preview = await post(
          f,
          postingInput(
            f,
            invoice.id,
            example.date,
            direction,
            direction === 'sale' ? 'none' : 'full',
          ),
        );
        expect(preview.lines).toEqual(
          direction === 'sale'
            ? [
                { account: '4111', debit: example.gross, credit: '0.00' },
                { account: '704', debit: '0.00', credit: '100.00' },
                { account: '4427', debit: '0.00', credit: example.tax },
              ]
            : [
                { account: '628', debit: '100.00', credit: '0.00' },
                { account: '401', debit: '0.00', credit: example.gross },
                { account: '4426', debit: example.tax, credit: '0.00' },
              ],
        );
        expect(generalBodySchema.parse(preview.body).invoice).toMatchObject({
          tax: example.tax,
          ruleId:
            example.rate === '19' ? 'ro-domestic-standard-2025-01' : 'ro-domestic-standard-2025-08',
        });
      }
    });

  for (const year of [2025, 2026])
    test(`non-VAT ${year} sales carry no output tax and VAT on purchases becomes cost`, async () => {
      const f = await fixture(year, 'non_vat'),
        date = `${year}-10-01`;
      const sale = (
        await importXml(f, {
          direction: 'sale',
          date,
          category: 'O',
          rate: '0',
          tax: '0.00',
          gross: '100.00',
        })
      ).invoice;
      expect((await post(f, postingInput(f, sale.id, date, 'sale', 'none'))).lines).toEqual([
        { account: '4111', debit: '100.00', credit: '0.00' },
        { account: '704', debit: '0.00', credit: '100.00' },
      ]);
      const purchase = (await importXml(f, { date })).invoice;
      expect((await post(f, postingInput(f, purchase.id, date, 'purchase', 'none'))).lines).toEqual(
        [
          { account: '628', debit: '121.00', credit: '0.00' },
          { account: '401', debit: '0.00', credit: '121.00' },
        ],
      );
      const balances = (
        await service.ledger.balance(f.actor, { financialYearId: f.financialYear.id })
      ).balances;
      expect(balances.some((row) => ['4426', '4427'].includes(row.account))).toBe(false);
    });

  test('reimport and concurrent proposals preserve one invoice and one posted entry', async () => {
    const f = await fixture(2026, 'normal_vat');
    const { source, invoice } = await importXml(f);
    expect(await service.invoices.import(f.actor, key(), { evidenceId: source.id })).toEqual(
      invoice,
    );
    const same = await importXml(
      f,
      {},
      invoiceXml().replaceAll('cbc:', 'basic:').replace('xmlns:cbc=', 'xmlns:basic='),
    );
    expect(same.invoice.id).toBe(invoice.id);
    const input = postingInput(f, invoice.id),
      commandKey = key();
    const [a, b] = await Promise.all([
      service.invoices.propose(f.actor, commandKey, input),
      service.invoices.propose(f.actor, key(), input),
    ]);
    expect(a.id).toBe(b.id);
    await service.books.approve(f.actor, key(), a.id, review(a));
    const [first, retry] = await Promise.all([
      service.ledger.post(f.actor, key(), { id: a.id, ...review(a) }),
      service.ledger.post(f.actor, key(), { id: a.id, ...review(a) }),
    ]);
    expect(first.id).toBe(retry.id);
    expect((await service.invoices.propose(f.actor, commandKey, input)).id).toBe(a.id);
    expect((await service.overview(f.actor)).journals).toHaveLength(1);
    const conflicting = invoiceXml({net: '200.00', tax: '42.00', gross: '242.00'});
    await expect(importXml(f, {}, conflicting)).rejects.toMatchObject({code: 'INVOICE_SOURCE_CONFLICT'});
    await expect(importXml(f, {date: '2026-10-02'})).rejects.toMatchObject({code: 'INVOICE_SOURCE_CONFLICT'});
    expect((await service.invoices.list(f.actor, {})).items).toHaveLength(1);
    await expect(
      db.orm
        .update(invoiceDocuments)
        .set({ hash: '0'.repeat(64) })
        .where(eq(invoiceDocuments.id, invoice.id))
        .execute(),
    ).rejects.toThrow();
  });

  test('missing registration, cash VAT, invalid deduction and new historical facts block automatic treatment', async () => {
    const f = await fixture();
    const { invoice } = await importXml(f);
    const input = postingInput(f, invoice.id);
    await expect(service.invoices.propose(f.actor, key(), input)).rejects.toMatchObject({
      code: 'NEEDS_EVIDENCE',
    });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'non_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: f.proof.id,
    });
    await expect(service.invoices.propose(f.actor, key(), input)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ACCOUNT',
    });
    const proposal = await service.invoices.propose(f.actor, key(), {
      ...input,
      deduction: 'none',
    });
    await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'normal_vat',
      effectiveFrom: '2026-09-01',
      evidenceId: f.proof.id,
    });
    await expect(
      service.ledger.post(f.actor, key(), { id: proposal.id, ...review(proposal) }),
    ).rejects.toMatchObject({ code: 'NEEDS_EVIDENCE' });
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat_collection',
      value: 'yes',
      effectiveFrom: '2026-09-01',
      evidenceId: f.proof.id,
    });
    await expect(service.invoices.propose(f.actor, key(), input)).rejects.toMatchObject({
      code: 'UNSUPPORTED_TREATMENT',
    });
    expect((await service.overview(f.actor)).journals).toHaveLength(0);
  });

  test('retains foreign, reduced-rate and credit-note facts without inventing their treatment', async () => {
    const f = await fixture(2026, 'normal_vat');
    for (const input of [
      { number: 'EU-1', country: 'IE' },
      { number: 'REDUCED-1', rate: '11', tax: '11.00', gross: '111.00' },
      { number: 'CN-1', credit: true },
      { number: 'FX-1', currency: 'EUR' },
    ]) {
      const { invoice } = await importXml(f, input);
      await expect(
        service.invoices.propose(f.actor, key(), postingInput(f, invoice.id)),
      ).rejects.toThrow();
      expect((await service.invoices.get(f.actor, invoice.id)).id).toBe(invoice.id);
      if (input.credit) expect(invoice.body.originalInvoiceNumber).toBe('INV-ORIGINAL');
    }
    const { invoice } = await importXml(f);
    await expect(
      service.invoices.propose(f.actor, key(), {
        ...postingInput(f, invoice.id),
        serviceDate: '2026-09-30',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PERIOD_TREATMENT' });
    expect((await service.invoices.list(f.actor, {})).items).toHaveLength(5);
  });

  test('rejects wrong standard rate and structurally balanced but wrong tax arithmetic', async () => {
    const f = await fixture(2026, 'normal_vat');
    const oldRate = (await importXml(f, { rate: '19', tax: '19.00', gross: '119.00' })).invoice;
    await expect(
      service.invoices.propose(f.actor, key(), postingInput(f, oldRate.id)),
    ).rejects.toMatchObject({ code: 'VAT_RATE' });
    const wrongTax = (await importXml(f, { number: 'WRONG-1', tax: '20.00', gross: '120.00' }))
      .invoice;
    await expect(
      service.invoices.propose(f.actor, key(), postingInput(f, wrongTax.id)),
    ).rejects.toMatchObject({ code: 'VAT_AMOUNT' });
    await expect(
      importXml(f, { number: 'BAD-1', tax: '21.00', gross: '122.00' }),
    ).rejects.toThrow();
  });

  test('XML is namespace-aware and rejects DTD/entity, duplicate-field and complexity attacks', () => {
    const valid = invoiceXml();
    expect(parseInvoiceXml(Buffer.from(valid)).number).toBe('INV-1');
    for (const xml of [
      valid.replace(
        '<Invoice ',
        '<!DOCTYPE Invoice [<!ENTITY secret SYSTEM "file:///etc/passwd">]><Invoice ',
      ),
      valid.replace('Servicii documentate', '&unknown;'),
      valid.replace('<cbc:ID>INV-1</cbc:ID>', '<cbc:ID>INV-1</cbc:ID><cbc:ID>INV-2</cbc:ID>'),
      valid.replace(
        'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
        'https://attacker.invalid/ns',
      ),
      valid.replace('Servicii documentate', 'x'.repeat(65537)),
      valid
        .replace('<cac:Price>', '<x>'.repeat(65) + '<cac:Price>')
        .replace('</cac:Price>', '</cac:Price>' + '</x>'.repeat(65)),
      valid.replace('currencyID="RON">121.00', 'currencyID="EUR">121.00'),
    ])
      expect(() => parseInvoiceXml(Buffer.from(xml))).toThrow();
  });

  test('company access and delegation remain enforced across import and posting preparation', async () => {
    const f = await fixture(2026, 'normal_vat'),
      other = await fixture(2026, 'normal_vat');
    const { invoice, source } = await importXml(f);
    await expect(service.invoices.get(other.actor, invoice.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      service.invoices.import(other.actor, key(), { evidenceId: source.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.invoices.propose(other.actor, key(), postingInput(other, invoice.id)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'Invoice agent',
      scopes: ['invoices.propose', 'proposals.get', 'ledger.post'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const actor = { ...f.actor, agentId: grant.id };
    const proposal = await service.invoices.propose(actor, key(), postingInput(f, invoice.id));
    await expect(
      service.ledger.post(actor, key(), { id: proposal.id, ...review(proposal) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    expect(
      await service.ledger.post(actor, key(), { id: proposal.id, ...review(proposal) }),
    ).toMatchObject({ number: 1 });
    await expect(
      service.invoices.propose(actor, key(), {
        ...postingInput(f, invoice.id),
        treatmentEvidenceId: other.proof.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('month close detects an imported invoice with no accounting interpretation', async () => {
    const f = await fixture(2026, 'non_vat');
    const opening = await service.ledger.propose(f.actor, key(), {
      financialYearId: f.financialYear.id,
      evidenceId: f.proof.id,
      date: '2026-01-01',
      purpose: 'opening',
      description: 'Poziție inițială verificată',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    });
    await service.books.approve(f.actor, key(), opening.id, review(opening));
    await service.ledger.post(f.actor, key(), { id: opening.id, ...review(opening) });
    await importXml(f);
    await expect(service.periods.close(f.actor, key(), '2026-10-01')).rejects.toMatchObject({
      code: 'UNPOSTED_INVOICES',
    });
  });

  test('evidenced policy revisions and reference catalogues are versioned without claiming fiscal conformance', async () => {
    const f = await fixture();
    const input = {
      key: 'prior_period_errors',
      expectedVersion: 0,
      effectiveFrom: '2026-01-01',
      title: 'Politica de corectare a erorilor',
      body: { materiality: { amount: '1000.00', basis: 'RON' } },
      evidenceId: f.proof.id,
    };
    const first = await service.foundation.recordPolicy(f.actor, key(), input);
    await expect(service.foundation.recordPolicy(f.actor, key(), input)).rejects.toMatchObject({
      code: 'STALE_VERSION',
    });
    const second = await service.foundation.recordPolicy(f.actor, key(), {
      ...input,
      expectedVersion: 1,
      effectiveFrom: '2026-07-01',
      body: { materiality: { amount: '500.00', basis: 'RON' } },
    });
    expect(
      (await service.foundation.policies(f.actor, { key: input.key, date: '2026-06-30' }))?.id,
    ).toBe(first.id);
    expect(
      (await service.foundation.policies(f.actor, { key: input.key, date: '2026-07-01' }))?.id,
    ).toBe(second.id);
    await expect(
      db.orm
        .update(accountingPolicies)
        .set({ title: 'Tampered' })
        .where(eq(accountingPolicies.id, first.id))
        .execute(),
    ).rejects.toThrow();
    expect((await service.foundation.rules(f.actor)).every((rule) => rule.status === 'draft')).toBe(
      true,
    );
    expect(
      (await service.foundation.obligationCatalogue(f.actor)).find((item) => item.id === 'D406')
        ?.status,
    ).toBe('not_implemented');
  });
});
