import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { buyerDetails, sellerDetails, type Issued } from './fixtures/sales';
import { scenario, type Scenario } from './scenario';

// A shop on the stock register (G1), from its invoices. Amounts by hand, at 21%:
//   bought: 10 bags of coffee for 100,00 (+21,00 VAT), then 10 for 120,00 (+25,20); one invoice
//     also has 2 boxes of paper for 40,00;
//   sold: 12 bags for 300,00 (+63,00): FIFO 10 × 10,00 + 2 × 12,00 = 124,00; CMP after each
//     receipt (20 bags at 11,00) 132,00;
//   the customer returns 2 bags (credit note of 50,00 + 10,50): back at the cost the sale took
//     them out at, FIFO 124,00 × 2 ÷ 12 = 20,67, CMP 22,00;
//   2 bags go back to the supplier on its credit note of 24,00 + 5,04: out of the second lot
//     (FIFO), out of the pool (CMP).

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

async function shop(method: 'fifo' | 'average') {
  const s = await scenario({ clock: () => Date.parse('2026-11-10T10:00:00Z') });
  open.push(s);
  for (const [axis, value] of Object.entries({
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    'policy.stock.valuation': method,
    'policy.stock.inventory': 'permanent',
    'policy.stock.negative': 'refuse',
  }))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await s.invoke(s.owner, 'sales.seller.record', { details: sellerDetails });
  const buyer = await s.party('Client Test SRL', '14399840');
  await s.invoke(s.owner, 'parties.recordDetails', {
    partyId: buyer.id,
    details: buyerDetails('14399840'),
  });
  const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
    code: 'XF',
    prefix: 'XF',
    width: 4,
    revenueAccount: '707',
  });
  const coffee = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
    code: 'CAF-1',
    name: 'Cafea boabe 1 kg',
    unit: 'H87',
    account: '371',
    nc8: '09012100',
    vatCategory: 'standard',
  });
  const paper = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
    code: 'HRT-1',
    name: 'Hârtie A4',
    unit: 'XBX',
    account: '3028',
  });
  const store = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
    code: 'M1',
    name: 'Magazin',
    keeper: 'Ionescu Maria',
  });
  const imported = async (input: XmlInput) => {
    const xml = invoiceXml(input);
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(xml).toString('base64'),
    });
    return s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId });
  };
  const issue = (input: Record<string, unknown>) =>
    s.invoke<Issued>(s.owner, 'sales.issue', {
      seriesId: series.id,
      buyerId: buyer.id,
      issueDate: '2026-03-12',
      ...input,
    });
  const proposal = (id: string) => s.invoke<ProposalView>(s.owner, 'proposals.get', { id });
  return { s, coffee, paper, store, imported, issue, proposal };
}

describe('a shop on the stock register', () => {
  for (const method of ['fifo', 'average'] as const)
    test(`buys, sells, takes back and returns goods (${method})`, async () => {
      const { s, coffee, paper, store, imported, issue, proposal } = await shop(method);
      const first = await imported({
        number: 'F-1',
        date: '2026-03-02',
        net: '140.00',
        tax: '29.40',
        gross: '169.40',
        lines: [
          { rate: '21', net: '100.00', name: 'Cafea boabe' },
          { rate: '21', net: '40.00', name: 'Hârtie A4' },
        ],
      });
      // Without the goods' mapping a stock account is refused, as before the register.
      const unmapped = await s.propose('invoices.recognize', {
        documentId: first.id,
        allocations: [
          { account: '371', vat: 'S-21', amount: '100.00' },
          { account: '3028', vat: 'S-21', amount: '40.00' },
        ],
      });
      expect(codes(unmapped)).toContain('ACCOUNT');
      const nir = await s.revise('invoices.recognize', unmapped, {
        documentId: first.id,
        allocations: [
          { account: '371', vat: 'S-21', amount: '100.00' },
          { account: '3028', vat: 'S-21', amount: '40.00' },
        ],
        stock: {
          warehouseId: store.id,
          lines: [
            { line: '1', itemId: coffee.id, quantity: '10' },
            { line: '2', itemId: paper.id, quantity: '2' },
          ],
        },
      });
      expect(codes(nir)).toEqual([]);
      expect(lines(nir)).toEqual(['D 371 100.00', 'D 3028 40.00', 'D 4426 29.40', 'C 401 169.40']);
      expect(
        nir.effect!.stockMoves!.map((move) => `${move.quantity} ${move.amount} ${move.line}`),
      ).toEqual(['10.000 100.00 0', '2.000 40.00 1']);
      await s.post(await s.approve(nir));

      // The second invoice: one bag short at the reception, claimed from the supplier.
      const second = await imported({
        number: 'F-2',
        date: '2026-03-05',
        net: '132.00',
        tax: '27.72',
        gross: '159.72',
        lines: [{ rate: '21', net: '132.00', name: 'Cafea boabe' }],
      });
      const short = await s.propose('invoices.recognize', {
        documentId: second.id,
        account: '371',
        stock: {
          warehouseId: store.id,
          lines: [{ line: '1', itemId: coffee.id, quantity: '11', received: '10' }],
        },
      });
      expect(codes(short)).toEqual(['RECEIPT_DIFFERENCE']);
      expect(lines(short)).toEqual(['D 371 120.00', 'D 4426 27.72', 'C 401 159.72', 'D 461 12.00']);
      await s.post(await s.approve(short, s.reviewer, ['RECEIPT_DIFFERENCE']));

      // Sold on the company's invoice, discharged at the policy's value.
      const sale = await issue({
        lines: [
          {
            name: 'Cafea boabe 1 kg',
            quantity: '12',
            unitCode: 'H87',
            price: '25',
            vat: { category: 'S', rate: '21' },
          },
        ],
        stock: { warehouseId: store.id, lines: [{ index: 0, itemId: coffee.id }] },
      });
      expect(sale.recognition.error).toBe(null);
      const sold = await proposal(sale.recognition.proposalId!);
      expect(codes(sold)).toEqual([]);
      const cost = method === 'fifo' ? '124.00' : '132.00';
      expect(lines(sold)).toEqual([
        'D 4111 363.00',
        'C 707 300.00',
        'C 4427 63.00',
        `C 371 ${cost}`,
        `D 607 ${cost}`,
      ]);
      await s.post(await s.approve(sold));

      // The customer brings 2 bags back: they re-enter at their cost.
      const credit = await issue({
        typeCode: '381',
        issueDate: '2026-03-14',
        precedingDocumentIds: [sale.documentId],
        lines: [
          {
            name: 'Cafea boabe 1 kg',
            quantity: '2',
            unitCode: 'H87',
            price: '25',
            vat: { category: 'S', rate: '21' },
          },
        ],
        stock: { warehouseId: store.id, lines: [{ index: 0, itemId: coffee.id }] },
      });
      const back = await proposal(credit.recognition.proposalId!);
      expect(codes(back)).toEqual([]);
      const returned = method === 'fifo' ? '20.67' : '22.00';
      expect(lines(back)).toEqual([
        'D 4111 -60.50',
        'C 707 -50.00',
        'C 4427 -10.50',
        `C 371 -${returned}`,
        `D 607 -${returned}`,
      ]);
      await s.post(await s.approve(back));

      // Two bags back to the supplier, on its credit note against F-2.
      const supplierCredit = await imported({
        number: 'NC-7',
        date: '2026-03-15',
        credit: true,
        originalNumber: 'F-2',
        net: '24.00',
        tax: '5.04',
        gross: '29.04',
        lines: [{ rate: '21', net: '24.00', name: 'Cafea boabe' }],
      });
      const refund = await s.propose('invoices.credit', {
        documentId: supplierCredit.id,
        originalDocumentId: second.id,
        account: '371',
        stock: { warehouseId: store.id, lines: [{ line: '1', itemId: coffee.id, quantity: '2' }] },
      });
      expect(codes(refund)).toEqual([]);
      expect(lines(refund)).toEqual(['D 371 -24.00', 'D 4426 -5.04', 'C 401 -29.04']);
      expect(refund.effect!.stockMoves!.map((move) => `${move.quantity} ${move.amount}`)).toEqual([
        '-2.000 -24.00',
      ]);
      await s.post(await s.approve(refund));

      const register = await s.invoke<{
        positions: { code: string; quantity: string; value: string }[];
        accounts: { account: string; register: string; ledger: string; outside: string }[];
      }>(s.owner, 'stock.register', {});
      const held = method === 'fifo' ? '92.67' : '86.00';
      expect(register.positions.map((row) => `${row.code} ${row.quantity} ${row.value}`)).toEqual([
        `CAF-1 8.000 ${held}`,
        'HRT-1 2.000 40.00',
      ]);
      expect(
        register.accounts.every((row) => row.register === row.ledger && row.outside === '0.00'),
      ).toBe(true);
      const close = await s.close('2026-03');
      expect(
        (close.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
      ).not.toContain('STOCK_LEDGER_DIFFERS');
    });
});
