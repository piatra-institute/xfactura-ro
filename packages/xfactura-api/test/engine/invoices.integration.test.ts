import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { lockTaxPeriod } from './fixtures/locks';
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

  test('a July supply invoiced in August with its date (BT-72) takes 19%, with VAT in July', async () => {
    // Codul fiscal art. 282 alin. (1) and 291 alin. (4): the supply's date gives the rate and the
    // exigibility; without it the issue date stands for it, and 19% is no longer in force.
    const s = await scenario({ year: 2025 });
    open.push(s);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'vat.status',
      value: 'normal_vat',
      effectiveFrom: '2025-01-01',
      evidenceId: (await s.evidence('certificat-tva.pdf')).id,
    });
    const nineteen = {
      direction: 'sale' as const,
      date: '2025-08-05',
      rate: '19',
      tax: '19.00',
      gross: '119.00',
    };
    const dated = await importInvoice(s, {
      ...nineteen,
      number: 'V-07',
      deliveryDate: '2025-07-28',
    });
    const proposal = await s.propose('invoices.recognize', {
      documentId: dated.id,
      account: '704',
    });
    expect(codes(proposal)).toEqual([]);
    expect(proposal.effect?.taxEntries[0]).toMatchObject({ code: 'S-19', taxPeriod: '2025-07' });
    expect(proposal.rules.used).toEqual([{ id: 'ro.vat.rate/S/2024-01-01', status: 'extracted' }]);
    const undated = await importInvoice(s, { ...nineteen, number: 'V-08' });
    expect(
      codes(await s.propose('invoices.recognize', { documentId: undated.id, account: '704' })),
    ).toEqual(['VAT_RATE', 'SUPPLY_DATE_ASSUMED']);
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
    // The reduced rate in force posts once the reviewer confirms the supply qualifies for it.
    const eleven = await importInvoice(s, {
      number: 'F-11',
      rate: '11',
      tax: '11.00',
      gross: '111.00',
    });
    const reduced = await s.propose('invoices.recognize', {
      documentId: eleven.id,
      account: '628',
    });
    expect(reduced.issues.map((issue) => `${issue.code}/${issue.severity}`)).toEqual([
      'REDUCED_RATE/ack',
    ]);
    expect((await s.refused(s.approve(reduced)))?.code).toBeDefined();
    await s.post(await s.approve(reduced, s.reviewer, ['REDUCED_RATE']));
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

describe('invoices on several accounts and rates', () => {
  const mixed = {
    number: 'F-MIX',
    net: '1200.00',
    tax: '232.00',
    gross: '1432.00',
    taxes: [
      { rate: '21', net: '1000.00', tax: '210.00' },
      { rate: '11', net: '200.00', tax: '22.00' },
    ],
  };
  const vat = (proposal: ProposalView) =>
    proposal.effect?.taxEntries.map(
      (entry) =>
        `${entry.key} ${entry.code} ${entry.base}/${entry.amount} deducted ${entry.deductible} line ${entry.line ?? '-'}`,
    );

  test('each VAT category split over accounts, each part with its own deduction', async () => {
    const s = await company();
    const document = await importInvoice(s, mixed);
    const proposal = await s.propose('invoices.recognize', {
      documentId: document.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '700.00' },
        { account: '6022', vat: 'S-21', amount: '300.00' },
        // Protocol at the reduced rate, its VAT not deducted.
        { account: '623', vat: 'S-11', amount: '200.00', deduction: 'none' },
      ],
    });
    expect(lines(proposal)).toEqual([
      'D 628 700.00',
      'D 6022 300.00',
      'D 623 222.00',
      'D 4426 210.00',
      'C 401 1432.00',
    ]);
    expect(vat(proposal)).toEqual([
      'vat:S-21 S-21 1000.00/210.00 deducted 210.00 line 3',
      'vat:S-11 S-11 200.00/22.00 deducted 0.00 line -',
    ]);
    // The part on 6022 (fuel) names no car: the reviewer confirms it (art. 298).
    expect(proposal.issues.map((issue) => issue.code)).toContain('VEHICLE_UNNAMED');
    await s.post(await s.approve(proposal, s.reviewer, ['REDUCED_RATE', 'VEHICLE_UNNAMED']));
    expect(await balance(s, '401')).toEqual({ debit: '0.00', credit: '1432.00' });
  });

  test('a credit note on both rates reverses each part with its deduction', async () => {
    const s = await company();
    const document = await importInvoice(s, mixed);
    const original = await s.propose('invoices.recognize', {
      documentId: document.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '1000.00' },
        { account: '623', vat: 'S-11', amount: '200.00', deduction: 'none' },
      ],
    });
    await s.post(await s.approve(original, s.reviewer, ['REDUCED_RATE']));
    const note = await importInvoice(s, {
      number: 'CN-MIX',
      credit: true,
      originalNumber: 'F-MIX',
      net: '150.00',
      tax: '26.50',
      gross: '176.50',
      taxes: [
        { rate: '21', net: '100.00', tax: '21.00' },
        { rate: '11', net: '50.00', tax: '5.50' },
      ],
    });
    const credited = await s.propose('invoices.credit', {
      documentId: note.id,
      originalDocumentId: document.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '100.00' },
        { account: '623', vat: 'S-11', amount: '50.00', deduction: 'none' },
      ],
    });
    expect(lines(credited)).toEqual([
      'D 628 -100.00',
      'D 623 -55.50',
      'D 4426 -21.00',
      'C 401 -176.50',
    ]);
    expect(vat(credited)).toEqual([
      'vat:S-21 S-21 -100.00/-21.00 deducted -21.00 line 2',
      'vat:S-11 S-11 -50.00/-5.50 deducted 0.00 line -',
    ]);
    await s.post(await s.approve(credited, s.reviewer, ['REDUCED_RATE']));
    expect(await balance(s, '401')).toEqual({ debit: '0.00', credit: '1255.50' });
  });

  test('one account takes every category; a sale collects VAT by rate', async () => {
    const s = await company();
    const purchase = await importInvoice(s, mixed);
    const single = await s.propose('invoices.recognize', {
      documentId: purchase.id,
      account: '628',
    });
    expect(lines(single)).toEqual([
      'D 628 1000.00',
      'D 628 200.00',
      'D 4426 210.00',
      'D 4426 22.00',
      'C 401 1432.00',
    ]);
    const sale = await importInvoice(s, { ...mixed, number: 'V-MIX', direction: 'sale' });
    const recognized = await s.propose('invoices.recognize', {
      documentId: sale.id,
      account: '704',
    });
    expect(lines(recognized)).toEqual([
      'D 4111 1432.00',
      'C 704 1000.00',
      'C 704 200.00',
      'C 4427 210.00',
      'C 4427 22.00',
    ]);
    expect(vat(recognized)).toEqual([
      'vat:S-21 S-21 1000.00/210.00 deducted 0.00 line 3',
      'vat:S-11 S-11 200.00/22.00 deducted 0.00 line 4',
    ]);
  });

  test('a car not used only for the business: half of its VAT deducted (Codul fiscal art. 298)', async () => {
    const s = await company();
    const fuel = await importInvoice(s, {
      number: 'F-FUEL',
      net: '200.00',
      tax: '42.00',
      gross: '242.00',
    });
    const proposal = await s.propose('invoices.recognize', {
      documentId: fuel.id,
      account: '6022',
      deduction: 'limited',
    });
    expect(lines(proposal)).toEqual(['D 6022 221.00', 'D 4426 21.00', 'C 401 242.00']);
    expect(vat(proposal)).toEqual(['vat S-21 200.00/42.00 deducted 21.00 line 1']);
    // A company outside VAT deducts nothing, limited or not.
    const outside = await company('non_vat');
    const other = await importInvoice(outside, {
      number: 'F-FUEL',
      net: '200.00',
      tax: '42.00',
      gross: '242.00',
    });
    expect(
      codes(
        await outside.propose('invoices.recognize', {
          documentId: other.id,
          account: '6022',
          deduction: 'limited',
        }),
      ),
    ).toEqual(['DEDUCTION']);
  });

  test('allocations must cover each category exactly, and keep assets apart from expenses', async () => {
    const s = await company();
    let attempt = 0;
    const propose = async (allocations: unknown[]) => {
      const document = await importInvoice(s, { ...mixed, number: `F-MIX-${++attempt}` });
      return s.propose('invoices.recognize', { documentId: document.id, allocations });
    };
    expect(
      codes(
        await propose([
          { account: '628', vat: 'S-21', amount: '900.00' },
          { account: '623', vat: 'S-11', amount: '200.00' },
        ]),
      ),
    ).toEqual(['REDUCED_RATE', 'ALLOCATION']);
    expect(
      codes(
        await propose([
          { account: '628', vat: 'S-21', amount: '1000.00' },
          { account: '623', vat: 'S-19', amount: '200.00' },
        ]),
      ),
    ).toEqual(['REDUCED_RATE', 'ALLOCATION', 'ALLOCATION']);
    expect(
      codes(
        await propose([
          { account: '2131', vat: 'S-21', amount: '1000.00' },
          { account: '623', vat: 'S-11', amount: '200.00' },
        ]),
      ),
    ).toEqual(['REDUCED_RATE', 'ACCOUNT_MIX']);
    expect(
      (
        await s.refused(
          s.propose('invoices.recognize', {
            documentId: (await importInvoice(s, { ...mixed, number: 'F-MIX-BOTH' })).id,
            account: '628',
            allocations: [{ account: '628', vat: 'S-21', amount: '1000.00' }],
          }),
        )
      )?.code,
    ).toBeDefined();
  });
});

describe('advances (419, 4091, 4092)', () => {
  const advanceOf = async (s: Scenario, kind: string) => {
    const [item] = await s.list<{ id: string; balance: string }>(s.owner, 'openItems.list', {
      kind,
    });
    return item!;
  };

  test('an advance invoiced to a customer, then deducted on the final invoice by a negative line', async () => {
    const s = await company();
    const advance = await importInvoice(s, {
      number: 'V-AV1',
      direction: 'sale',
      date: '2026-10-05',
      net: '3000.00',
      tax: '630.00',
      gross: '3630.00',
    });
    const advanced = await s.propose('invoices.recognize', {
      documentId: advance.id,
      allocations: [{ account: '419', vat: 'S-21', amount: '3000.00' }],
    });
    expect(lines(advanced)).toEqual(['D 4111 3630.00', 'C 419 3000.00', 'C 4427 630.00']);
    await s.post(await s.approve(advanced));
    const held = await advanceOf(s, 'advance.received');

    // The final invoice: 10,000 lei of services less the 3,000-lei advance, VAT on 7,000.
    const final = await importInvoice(s, {
      number: 'V-FIN',
      direction: 'sale',
      date: '2026-10-25',
      net: '7000.00',
      tax: '1470.00',
      gross: '8470.00',
      lines: [
        { rate: '21', net: '10000.00' },
        { rate: '21', net: '-3000.00', name: 'Avans încasat (V-AV1)' },
      ],
    });
    const propose = (amount: string, advance?: string) =>
      s.propose('invoices.recognize', {
        documentId: final.id,
        allocations: [
          { account: '704', vat: 'S-21', amount: '10000.00' },
          { account: '419', vat: 'S-21', amount, ...(advance ? { advance } : {}) },
        ],
      });
    const settled = await propose('-3000.00', held.id);
    expect(lines(settled)).toEqual([
      'D 4111 8470.00',
      'C 704 10000.00',
      'C 419 -3000.00',
      'C 4427 1470.00',
    ]);
    await s.post(await s.approve(settled));
    expect(await balance(s, '419')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await balance(s, '4427')).toEqual({ debit: '0.00', credit: '2100.00' });
    expect(await balance(s, '704')).toEqual({ debit: '0.00', credit: '10000.00' });
  });

  test('a supplier’s advance on 4092, settled by the final invoice', async () => {
    const s = await company();
    const advance = await importInvoice(s, {
      number: 'F-AV1',
      date: '2026-10-05',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
    });
    const paid = await s.propose('invoices.recognize', {
      documentId: advance.id,
      allocations: [{ account: '4092', vat: 'S-21', amount: '1000.00' }],
    });
    expect(lines(paid)).toEqual(['D 4092 1000.00', 'D 4426 210.00', 'C 401 1210.00']);
    await s.post(await s.approve(paid));
    const held = await advanceOf(s, 'advance.paid');
    const final = await importInvoice(s, {
      number: 'F-FIN',
      date: '2026-10-25',
      net: '4000.00',
      tax: '840.00',
      gross: '4840.00',
      lines: [
        { rate: '21', net: '5000.00' },
        { rate: '21', net: '-1000.00' },
      ],
    });
    const settled = await s.propose('invoices.recognize', {
      documentId: final.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '5000.00' },
        { account: '4092', vat: 'S-21', amount: '-1000.00', advance: held.id },
      ],
    });
    expect(lines(settled)).toEqual([
      'D 628 5000.00',
      'D 4092 -1000.00',
      'D 4426 840.00',
      'C 401 4840.00',
    ]);
    await s.post(await s.approve(settled));
    expect(await balance(s, '4092')).toEqual({ debit: '0.00', credit: '0.00' });
  });

  test('a negative part settles a named advance of the partner, and never more than it holds', async () => {
    const s = await company();
    const advance = await importInvoice(s, {
      number: 'V-AV2',
      direction: 'sale',
      date: '2026-10-05',
      net: '3000.00',
      tax: '630.00',
      gross: '3630.00',
    });
    await s.book('invoices.recognize', {
      documentId: advance.id,
      allocations: [{ account: '419', vat: 'S-21', amount: '3000.00' }],
    });
    const held = await advanceOf(s, 'advance.received');
    let attempt = 0;
    const final = async (allocations: unknown[]) => {
      const document = await importInvoice(s, {
        number: `V-FIN-${++attempt}`,
        direction: 'sale',
        date: '2026-10-25',
        net: '6000.00',
        tax: '1260.00',
        gross: '7260.00',
        lines: [
          { rate: '21', net: '10000.00' },
          { rate: '21', net: '-4000.00' },
        ],
      });
      return s.propose('invoices.recognize', { documentId: document.id, allocations });
    };
    // Without the advance it settles.
    expect(
      codes(
        await final([
          { account: '704', vat: 'S-21', amount: '10000.00' },
          { account: '419', vat: 'S-21', amount: '-4000.00' },
        ]),
      ),
    ).toEqual(['ADVANCE']);
    // A negative amount anywhere but an advance.
    expect(
      codes(
        await final([
          { account: '704', vat: 'S-21', amount: '10000.00' },
          { account: '708', vat: 'S-21', amount: '-4000.00' },
        ]),
      ),
    ).toEqual(['ALLOCATION']);
    // 4,000 lei against an advance of 3,000: the advance would turn over.
    const over = await final([
      { account: '704', vat: 'S-21', amount: '10000.00' },
      { account: '419', vat: 'S-21', amount: '-4000.00', advance: held.id },
    ]);
    expect(codes(over)).toEqual(['OPEN_ITEM_REVERSED']);
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

describe('corrections', () => {
  test('a reversed invoice is free for a new booking, which its credit note then reads', async () => {
    const s = await company();
    const sale = await importInvoice(s, { number: 'V-20', direction: 'sale' });
    const first = await s.book('invoices.recognize', { documentId: sale.id, account: '704' });
    const other = { documentId: sale.id, account: '706' };
    // While the booking stands, the document is taken.
    expect((await s.refused(s.propose('invoices.recognize', other)))?.code).toBe('SUBJECT_EXISTS');
    // Booked on the wrong revenue account: the correction is a reversal and a new proposal.
    const { id: note } = await s.evidence('nota-storno.pdf');
    const reversal = {
      date: '2026-10-20',
      reason: 'Venitul a fost înregistrat pe alt cont decât cel al serviciului.',
      evidenceId: note,
      method: 'red' as const,
    };
    const reversed = await s.book('ledger.reverse', { entryId: first.entry!.id, ...reversal });
    // The document waits for a booking again, and the worklist says how to propose it.
    const work = await s.invoke<{
      items: { subject: { id: string }; next: { operation: string; inputHint: unknown }[] }[];
    }>(s.owner, 'work.list', { kinds: ['document.unproposed'] });
    expect(work.items.find((item) => item.subject.id === sale.id)?.next[0]).toEqual(
      expect.objectContaining({
        operation: 'proposals.propose',
        inputHint: { treatment: 'invoices.recognize', input: { documentId: sale.id } },
      }),
    );
    const again = await s.book('invoices.recognize', other);
    expect(again).toMatchObject({ status: 'posted', subject: first.subject });
    expect(again.id).not.toBe(first.id);
    // Booked otherwise once more only after this one is reversed too.
    expect(
      (await s.refused(s.propose('invoices.recognize', { ...other, account: '704' })))?.code,
    ).toBe('SUBJECT_EXISTS');
    // The first booking's receivable was cleared by its reversal; the new one's stays open.
    expect(await balance(s, '4111')).toEqual({ debit: '121.00', credit: '0.00' });
    expect(await balance(s, '704')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await balance(s, '706')).toEqual({ debit: '0.00', credit: '100.00' });
    // A credit note reduces the new booking's receivable, never the reversed one's.
    const credit = await importInvoice(s, {
      number: 'CN-20',
      direction: 'sale',
      credit: true,
      originalNumber: 'V-20',
      date: '2026-11-05',
      net: '50.00',
      tax: '10.50',
      gross: '60.50',
    });
    const credited = await s.book('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: sale.id,
      account: '706',
    });
    expect(credited.effect?.lines[0]).toMatchObject({
      account: '4111',
      amount: '-60.50',
      openItem: again.effect!.openItems[0]!.id,
    });
    expect(await balance(s, '4111')).toEqual({ debit: '60.50', credit: '0.00' });
    // A reversal is never reversed: the subject it freed is booked again instead.
    const undo = await s.propose('ledger.reverse', { entryId: reversed.entry!.id, ...reversal });
    expect(codes(undo)).toContain('REVERSAL_OF_REVERSAL');
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

    await lockTaxPeriod(s.db, s.company.id, s.owner.actorId, 'VAT', '2026-Q4');
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
