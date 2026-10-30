import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A cash desk funded with 2,000 lei from the bank on 1 October 2026, and an unpaid invoice. */
async function company() {
  const s = await scenario();
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('cec-numerar.pdf')).id,
      [
        { account: '5311', side: 'D', amount: '2000.00' },
        { account: '5121', side: 'C', amount: '2000.00' },
      ],
      { date: '2026-10-01' },
    ),
  );
  const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'F-1.xml',
    mediaType: 'application/xml',
    base64: Buffer.from(
      invoiceXml({
        number: 'F-1',
        date: '2026-10-02',
        net: '100.00',
        tax: '21.00',
        gross: '121.00',
      }),
    ).toString('base64'),
  });
  const invoice = await s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
    evidenceId: id,
  });
  await s.book('invoices.recognize', { documentId: invoice.id, account: '628' });
  const person = async (name: string) =>
    s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name,
    });
  const cash = async (input: Record<string, unknown>) =>
    s.propose('cash.record', {
      account: '5311',
      date: '2026-10-05',
      evidenceId: (await s.evidence(`${String(input.number)}.pdf`)).id,
      ...input,
    });
  return { s, invoice, person, cash };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

describe('cash', () => {
  test('an invoice paid in cash, an advance to an employee, an associate’s loan, in the cash register', async () => {
    const { s, invoice, person, cash } = await company();
    const [payable] = await s.invoke<{ id: string }[]>(s.owner, 'openItems.list', {
      kind: 'payable',
    });
    const paid = await cash({
      direction: 'payment',
      number: 'DP-1',
      partyId: invoice.partyId,
      allocations: [{ openItem: payable!.id, amount: '121.00' }],
    });
    expect(lines(paid)).toEqual(['C 5311 121.00', 'D 401 121.00']);
    await s.post(await s.approve(paid));

    const employee = await person('Ionescu Dan');
    const advance = await cash({
      direction: 'payment',
      number: 'DP-2',
      partyId: employee.id,
      opens: [{ account: '542', amount: '300.00' }],
    });
    expect(lines(advance)).toEqual(['C 5311 300.00', 'D 542 300.00']);
    await s.post(await s.approve(advance));

    // The advance accounted for: 220 lei of receipts, the 80 lei left returned in cash.
    const [held] = await s.invoke<{ id: string }[]>(s.owner, 'openItems.list', {
      partyId: employee.id,
    });
    const report = (expenses: unknown[]) =>
      s.evidence('decont.pdf').then(({ id }) =>
        s.propose('cash.expenseReport', {
          advanceId: held!.id,
          date: '2026-10-05',
          evidenceId: id,
          expenses,
        }),
      );
    expect(codes(await report([{ account: '628', amount: '400.00' }]))).toEqual(['EXCESS']);
    const decont = await s.propose('cash.expenseReport', {
      advanceId: held!.id,
      date: '2026-10-05',
      evidenceId: (await s.evidence('decont-2.pdf')).id,
      expenses: [
        { account: '628', amount: '120.00', memo: 'Taxi' },
        { account: '6022', amount: '100.00', memo: 'Combustibil' },
      ],
    });
    expect(lines(decont)).toEqual(['D 628 120.00', 'D 6022 100.00', 'C 542 220.00']);
    await s.post(await s.approve(decont));
    const returned = await cash({
      direction: 'receipt',
      number: 'C-0',
      partyId: employee.id,
      allocations: [{ openItem: held!.id, amount: '80.00' }],
    });
    expect(lines(returned)).toEqual(['D 5311 80.00', 'C 542 80.00']);
    await s.post(await s.approve(returned));
    expect((await s.trialBalance()).rows.find((row) => row.account === '542')?.closing).toEqual({
      debit: '0.00',
      credit: '0.00',
    });

    const associate = await person('Popescu Ana');
    const loan = await cash({
      direction: 'receipt',
      number: 'C-1',
      date: '2026-10-06',
      partyId: associate.id,
      opens: [{ account: '4551', amount: '6000.00' }],
    });
    expect(lines(loan)).toEqual(['D 5311 6000.00', 'C 4551 6000.00']);
    expect(loan.issues).toEqual([]);
    await s.post(await s.approve(loan));

    const register = await s.invoke<{
      opening: string;
      days: { date: string; movements: { document: string }[]; closing: string }[];
      closing: string;
    }>(s.owner, 'cash.register', { account: '5311', from: '2026-10-02', to: '2026-10-31' });
    expect(register.opening).toBe('2000.00');
    expect(
      register.days.map((day) => [
        day.date,
        day.movements.map((movement) => movement.document),
        day.closing,
      ]),
    ).toEqual([
      ['2026-10-05', ['DP-1', 'DP-2', 'C-0'], '1659.00'],
      ['2026-10-06', ['C-1'], '7659.00'],
    ]);
  });

  test('Legea 70/2015: limits are acknowledged, a negative cash desk is refused', async () => {
    const { s, invoice, person, cash } = await company();
    const [payable] = await s.invoke<{ id: string }[]>(s.owner, 'openItems.list', {
      kind: 'payable',
    });
    // More cash than the desk holds.
    expect(
      codes(
        await cash({
          direction: 'payment',
          number: 'DP-9',
          partyId: invoice.partyId,
          lines: [{ account: '628', amount: '2500.00' }],
        }),
      ),
    ).toEqual(['CASH_NEGATIVE']);
    // A company may receive 5,000 lei a day in cash from another: 6,000 lei is acknowledged.
    const large = await cash({
      direction: 'receipt',
      number: 'C-2',
      partyId: invoice.partyId,
      lines: [{ account: '7588', amount: '6000.00' }],
    });
    expect(large.issues.map((issue) => `${issue.code}/${issue.severity}`)).toEqual([
      'CASH_LIMIT/ack',
    ]);
    // More than 50,000 lei in the desk at the end of the day.
    const associate = await person('Popescu Ana');
    expect(
      codes(
        await cash({
          direction: 'receipt',
          number: 'C-3',
          partyId: associate.id,
          opens: [{ account: '4551', amount: '49000.00' }],
        }),
      ),
    ).toEqual(['CASH_LIMIT', 'CASH_CEILING']);
    // An advance is paid out, not received.
    expect(
      codes(
        await cash({
          direction: 'receipt',
          number: 'C-4',
          partyId: associate.id,
          opens: [{ account: '542', amount: '100.00' }],
        }),
      ),
    ).toEqual(['DIRECTION']);
    expect(payable).toBeDefined();
  });
});
