import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { taxPeriodEvents } from '../../source/engine/db/schema';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A company registered for VAT (or not) from the start of 2026. */
async function company(status: 'normal_vat' | 'non_vat' = 'normal_vat') {
  const s = await scenario();
  open.push(s);
  const { id: evidenceId } = await s.evidence('certificat-tva.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: status,
    effectiveFrom: '2026-01-01',
    evidenceId,
  });
  return s;
}
async function importInvoice(s: Scenario, input: XmlInput) {
  const xml = invoiceXml(input);
  const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: `${input.number ?? 'INV-1'}.xml`,
    mediaType: 'application/xml',
    base64: Buffer.from(xml).toString('base64'),
  });
  return s.invoke<{ id: string; kind: string; partyId: string }>(s.owner, 'invoices.import', {
    evidenceId,
  });
}
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const balance = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('import', () => {
  test('decides the direction from the company and records the counterparty once', async () => {
    const s = await company();
    const purchase = await importInvoice(s, { number: 'F-100' });
    const sale = await importInvoice(s, { number: 'V-1', direction: 'sale' });
    expect([purchase.kind, sale.kind]).toEqual(['invoice.received', 'invoice.issued']);
    // The same counterparty, CUI 87654321, is supplier of one and customer of the other.
    expect(purchase.partyId).toBe(sale.partyId);
    expect((await importInvoice(s, { number: 'F-100' })).id).toBe(purchase.id);
    expect(
      (
        await s.refused(
          importInvoice(s, { number: 'F-100', net: '90.00', tax: '18.90', gross: '108.90' }),
        )
      )?.code,
    ).toBe('DOCUMENT_CONFLICT');
  });

  test('refuses documents that do not involve the company', async () => {
    const s = await company();
    const xml = invoiceXml().replaceAll('12345678', '99999999');
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'strain.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(xml).toString('base64'),
    });
    expect((await s.refused(s.invoke(s.owner, 'invoices.import', { evidenceId })))?.code).toBe(
      'COUNTERPARTY',
    );
  });
});

describe('recognition', () => {
  test('a purchase books the expense, deductible VAT and the supplier payable', async () => {
    const s = await company();
    const document = await importInvoice(s, { number: 'F-1' });
    const proposal = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
    });
    expect(codes(proposal)).toEqual([]);
    expect(lines(proposal)).toEqual(['D 628 100.00', 'D 4426 21.00', 'C 401 121.00']);
    expect(proposal.effect?.taxEntries[0]).toMatchObject({
      code: 'S-21',
      direction: 'input',
      base: '100.00',
      amount: '21.00',
      deductible: '21.00',
      taxPeriod: '2026-10',
    });
    expect(proposal.rules.used).toEqual([{ id: 'ro.vat.rate/S/2025-08-01', status: 'extracted' }]);
    await s.post(await s.approve(proposal));
    expect(await balance(s, '401')).toEqual({ debit: '0.00', credit: '121.00' });
  });

  test('a sale books the receivable, revenue and output VAT', async () => {
    const s = await company();
    const document = await importInvoice(s, { number: 'V-1', direction: 'sale' });
    const proposal = await s.book('invoices.recognize', {
      documentId: document.id,
      account: '704',
    });
    expect(lines(proposal)).toEqual(['D 4111 121.00', 'C 704 100.00', 'C 4427 21.00']);
    expect(await balance(s, '4427')).toEqual({ debit: '0.00', credit: '21.00' });
  });

  test('VAT must match the rate in force and the company registration', async () => {
    const s = await company();
    const nineteen = await importInvoice(s, {
      number: 'V-19',
      direction: 'sale',
      rate: '19',
      tax: '19.00',
      gross: '119.00',
    });
    expect(
      codes(await s.propose('invoices.recognize', { documentId: nineteen.id, account: '704' })),
    ).toEqual(['VAT_RATE']);
    const missing = await scenario();
    open.push(missing);
    const unknown = await importInvoice(missing, { number: 'F-2' });
    expect(
      codes(
        await missing.propose('invoices.recognize', { documentId: unknown.id, account: '628' }),
      ),
    ).toEqual(['DETERMINATION_MISSING']);
  });

  test('a non-VAT company cannot deduct and books the VAT into the expense', async () => {
    const s = await company('non_vat');
    const document = await importInvoice(s, { number: 'F-3' });
    expect(
      codes(await s.propose('invoices.recognize', { documentId: document.id, account: '628' })),
    ).toEqual(['DEDUCTION']);
    const other = await importInvoice(s, { number: 'F-4' });
    const proposal = await s.propose('invoices.recognize', {
      documentId: other.id,
      account: '628',
      deduction: 'none',
    });
    expect(lines(proposal)).toEqual(['D 628 121.00', 'C 401 121.00']);
    expect(proposal.effect?.taxEntries[0]).toMatchObject({ deductible: '0.00', booked: '0.00' });
  });

  test('a date past the reviewed rules is a visible gap, not a default', async () => {
    const s = await company();
    const document = await importInvoice(s, { number: 'F-2027', date: '2027-01-04' });
    const proposal = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
    });
    expect(proposal.status).toBe('blocked');
    expect(proposal.issues[0]).toMatchObject({
      code: 'RULE_GAP',
      details: { reason: 'BEYOND_HORIZON', key: 'ro.vat.rate' },
    });
  });

  test('shadow books refuse rules nobody has interpreted yet', async () => {
    const s = await company();
    const { id: evidenceId } = await s.evidence('decizie.pdf');
    await s.invoke(s.owner, 'profile.record', {
      axis: 'books.assurance',
      value: 'shadow',
      effectiveFrom: '2026-01-01',
      evidenceId,
    });
    const document = await importInvoice(s, { number: 'F-5' });
    const proposal = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
    });
    expect(proposal.issues[0]).toMatchObject({
      code: 'RULE_GAP',
      details: { reason: 'INSUFFICIENT_REVIEW', have: 'extracted', need: 'interpreted' },
    });
  });

  test('a document is recognized once, whichever treatment is tried', async () => {
    const s = await company();
    const document = await importInvoice(s, { number: 'F-6' });
    const first = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
    });
    expect(
      (await s.propose('invoices.recognize', { documentId: document.id, account: '628' })).id,
    ).toBe(first.id);
    expect(
      (
        await s.refused(
          s.propose('invoices.recognize', { documentId: document.id, account: '627' }),
        )
      )?.code,
    ).toBe('SUBJECT_EXISTS');
  });
});

describe('credit notes', () => {
  async function saleWithCredit(s: Scenario, amounts: { net: string; tax: string; gross: string }) {
    const original = await importInvoice(s, { number: 'V-10', direction: 'sale' });
    await s.book('invoices.recognize', { documentId: original.id, account: '704' });
    const credit = await importInvoice(s, {
      number: 'CN-1',
      direction: 'sale',
      credit: true,
      originalNumber: 'V-10',
      date: '2026-11-05',
      ...amounts,
    });
    return { original, credit };
  }

  test('reverses the original accounts at the original rate in the credit period', async () => {
    const s = await company();
    const { original, credit } = await saleWithCredit(s, {
      net: '50.00',
      tax: '10.50',
      gross: '60.50',
    });
    const proposal = await s.book('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: original.id,
      account: '704',
    });
    expect(lines(proposal)).toEqual(['D 4111 -60.50', 'C 704 -50.00', 'C 4427 -10.50']);
    expect(proposal.effect?.taxEntries[0]).toMatchObject({
      amount: '-10.50',
      taxPeriod: '2026-11',
    });
    expect(await balance(s, '4111')).toEqual({ debit: '60.50', credit: '0.00' });
  });

  test('cannot credit more than remains open', async () => {
    const s = await company();
    const { original, credit } = await saleWithCredit(s, {
      net: '200.00',
      tax: '42.00',
      gross: '242.00',
    });
    const proposal = await s.propose('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: original.id,
      account: '704',
    });
    expect(codes(proposal)).toEqual(['OPEN_ITEM_REVERSED']);
  });

  test('must name the invoice it credits', async () => {
    const s = await company();
    const { credit } = await saleWithCredit(s, { net: '50.00', tax: '10.50', gross: '60.50' });
    const other = await importInvoice(s, { number: 'V-11', direction: 'sale' });
    await s.book('invoices.recognize', { documentId: other.id, account: '704' });
    const proposal = await s.propose('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: other.id,
      account: '704',
    });
    expect(codes(proposal)).toEqual(['REFERENCE']);
  });
});

describe('VAT journals', () => {
  test("a quarterly payer's tax entries fall in the quarter, which a lock closes", async () => {
    const s = await company();
    const { id: evidenceId } = await s.evidence('notificare-trimestrial.pdf');
    await s.invoke(s.owner, 'profile.record', {
      axis: 'vat.period',
      value: 'quarterly',
      effectiveFrom: '2026-01-01',
      evidenceId,
    });
    const sale = await importInvoice(s, { number: 'V-40', direction: 'sale', date: '2026-11-05' });
    await s.book('invoices.recognize', { documentId: sale.id, account: '704' });
    const journal = await s.invoke<{ rows: { taxPeriod: string; document: string }[] }>(
      s.owner,
      'vat.journal',
      { direction: 'output', from: '2026-Q4', to: '2026-Q4' },
    );
    expect(journal.rows.map((row) => `${row.taxPeriod} ${row.document}`)).toEqual(['2026-Q4 V-40']);

    await s.db.write((tx) =>
      tx.insert(taxPeriodEvents).values({
        companyId: s.company.id,
        tax: 'VAT',
        period: '2026-Q4',
        seq: 1,
        kind: 'lock',
        reference: 'D300 2026-Q4',
        createdBy: s.owner.actorId,
      }),
    );
    const late = await importInvoice(s, { number: 'V-41', direction: 'sale', date: '2026-12-01' });
    const proposal = await s.propose('invoices.recognize', { documentId: late.id, account: '704' });
    expect(proposal.issues.map((issue) => issue.code)).toContain('TAX_PERIOD_LOCKED');
  });

  test('list each tax entry in its period, with credits in their own period', async () => {
    const s = await company();
    const original = await importInvoice(s, { number: 'V-20', direction: 'sale' });
    await s.book('invoices.recognize', { documentId: original.id, account: '704' });
    const credit = await importInvoice(s, {
      number: 'CN-2',
      direction: 'sale',
      credit: true,
      originalNumber: 'V-20',
      date: '2026-11-05',
      net: '10.00',
      tax: '2.10',
      gross: '12.10',
    });
    await s.book('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: original.id,
      account: '704',
    });
    const purchase = await importInvoice(s, { number: 'F-20' });
    await s.book('invoices.recognize', { documentId: purchase.id, account: '628' });
    const sales = await s.invoke<{
      rows: { document: string; taxPeriod: string; vat: string }[];
      totals: unknown[];
    }>(s.owner, 'vat.journal', { direction: 'output', from: '2026-10', to: '2026-11' });
    expect(sales.rows.map((row) => `${row.taxPeriod} ${row.document} ${row.vat}`)).toEqual([
      '2026-10 V-20 21.00',
      '2026-11 CN-2 -2.10',
    ]);
    expect(sales.totals).toEqual([
      { code: 'S-21', base: '90.00', vat: '18.90', deductible: '0.00' },
    ]);
    const purchases = await s.invoke<{ totals: unknown[] }>(s.owner, 'vat.journal', {
      direction: 'input',
      from: '2026-10',
      to: '2026-10',
    });
    expect(purchases.totals).toEqual([
      { code: 'S-21', base: '100.00', vat: '21.00', deductible: '21.00' },
    ]);
  });
});
