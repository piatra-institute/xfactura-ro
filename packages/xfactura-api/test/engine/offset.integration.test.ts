import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A VAT payer, on VAT on collection or not, that sold 1,210 lei to a partner and bought 605 lei
 * from it in October 2026. */
async function company(cash: boolean) {
  const s = await scenario();
  open.push(s);
  const fact = async (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await fact('vat.status', 'normal_vat');
  await fact('vat.cash', cash ? 'yes' : 'no');
  const book = async (input: XmlInput, account: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml(input)).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    const posted = await s.book('invoices.recognize', { documentId: document.id, account });
    return posted.effect!.openItems[0]!.id;
  };
  const mention = cash ? { note: 'TVA la încasare' } : {};
  const receivable = await book(
    {
      number: 'V-1',
      direction: 'sale',
      date: '2026-10-05',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
      ...mention,
    },
    '704',
  );
  const payable = await book(
    { number: 'F-1', date: '2026-10-06', net: '500.00', tax: '105.00', gross: '605.00' },
    '628',
  );
  const offset = async (owed: string, owing: string) =>
    s.propose('items.offset', {
      date: '2026-10-20',
      evidenceId: (await s.evidence('proces-verbal-compensare.pdf')).id,
      receivables: [{ openItem: receivable, amount: owed }],
      payables: [{ openItem: payable, amount: owing }],
    });
  return { s, offset };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const closing = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('offset (compensare)', () => {
  test('what the partner owes and what the company owes it cancel for the same amount', async () => {
    const { s, offset } = await company(false);
    expect((await offset('605.00', '600.00')).issues.map((issue) => issue.code)).toEqual([
      'OFFSET_UNBALANCED',
    ]);
    const proposal = await offset('605.00', '605.00');
    expect(lines(proposal)).toEqual(['C 4111 605.00', 'D 401 605.00']);
    await s.post(await s.approve(proposal));
    expect(await closing(s, '4111')).toEqual({ debit: '605.00', credit: '0.00' });
    expect(await closing(s, '401')).toEqual({ debit: '0.00', credit: '0.00' });
  });

  test('under VAT on collection, the offset collects and pays: the VAT is released', async () => {
    const { s, offset } = await company(true);
    const proposal = await offset('605.00', '605.00');
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    // Half the sale is collected (105 of its 210 lei of VAT become chargeable) and the purchase
    // is paid in full (its 105 lei become deductible).
    expect(lines(proposal)).toEqual(
      expect.arrayContaining(['C 4111 605.00', 'D 401 605.00', 'C 4427 105.00', 'D 4426 105.00']),
    );
    await s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.map((issue) => issue.code),
      ),
    );
    expect(await closing(s, '4428')).toEqual({ debit: '0.00', credit: '105.00' });
  });
});
