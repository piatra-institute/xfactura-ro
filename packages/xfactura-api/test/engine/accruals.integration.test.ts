import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

async function company() {
  const s = await scenario();
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  // The fixture's counterparty, so that its invoices come from this partner.
  const partner = await s.party('Partener SRL', '87654321');
  const invoice = async (input: XmlInput, account: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml(input)).toString('base64'),
    });
    const document = await s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: id,
    });
    await s.book('invoices.recognize', { documentId: document.id, account });
    return document;
  };
  const accrue = async (account: string, amount: string) =>
    s.propose('accruals.record', {
      date: '2026-10-31',
      account,
      amount,
      partyId: partner.id,
      evidenceId: (await s.evidence(`pv-${account}.pdf`)).id,
    });
  const accrualOf = async (kind: string) =>
    (await s.invoke<{ id: string }[]>(s.owner, 'openItems.list', { kind }))[0]!.id;
  return { s, partner, invoice, accrue, accrualOf };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const closing = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('accruals (408, 418)', () => {
  test('a service received in October, invoiced in November: the accrual is reversed on the invoice', async () => {
    const { s, invoice, accrue, accrualOf } = await company();
    const accrued = await accrue('628', '500.00');
    expect(lines(accrued)).toEqual(['D 628 500.00', 'C 408 500.00']);
    await s.post(await s.approve(accrued));
    // The invoice comes for 520 lei: the 20 lei over the estimate fall in November.
    const arrived = await invoice(
      { number: 'F-NOV', date: '2026-11-05', net: '520.00', tax: '109.20', gross: '629.20' },
      '628',
    );
    const settled = await s.propose('accruals.settle', {
      accrualId: await accrualOf('accrual.payable'),
      documentId: arrived.id,
      date: '2026-11-05',
    });
    expect(lines(settled)).toEqual(['D 408 500.00', 'C 628 500.00']);
    await s.post(await s.approve(settled));
    expect(await closing(s, '408')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await closing(s, '628')).toEqual({ debit: '520.00', credit: '0.00' });
    const october = (await s.trialBalance('2026-10-01', '2026-10-31')).rows.find(
      (row) => row.account === '628',
    );
    expect(october?.closing).toEqual({ debit: '500.00', credit: '0.00' });
  });

  test('work rendered in October and invoiced in November, on 418', async () => {
    const { s, invoice, accrue, accrualOf } = await company();
    const accrued = await accrue('704', '1000.00');
    expect(lines(accrued)).toEqual(['D 418 1000.00', 'C 704 1000.00']);
    await s.post(await s.approve(accrued));
    const issued = await invoice(
      {
        number: 'V-NOV',
        direction: 'sale',
        date: '2026-11-03',
        net: '1000.00',
        tax: '210.00',
        gross: '1210.00',
      },
      '704',
    );
    const settled = await s.propose('accruals.settle', {
      accrualId: await accrualOf('accrual.receivable'),
      documentId: issued.id,
      date: '2026-11-03',
    });
    expect(lines(settled)).toEqual(['D 704 1000.00', 'C 418 1000.00']);
    await s.post(await s.approve(settled));
    expect(await closing(s, '418')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await closing(s, '704')).toEqual({ debit: '0.00', credit: '1000.00' });
  });

  test('an accrual is reversed by an invoice of the same partner', async () => {
    const { s, invoice, accrue, accrualOf } = await company();
    await s.post(await s.approve(await accrue('628', '500.00')));
    const other = await invoice(
      {
        number: 'F-ALT',
        date: '2026-11-05',
        net: '500.00',
        tax: '105.00',
        gross: '605.00',
        counterparty: '26000039',
      },
      '628',
    );
    const proposal = await s.propose('accruals.settle', {
      accrualId: await accrualOf('accrual.payable'),
      documentId: other.id,
      date: '2026-11-05',
    });
    expect(proposal.issues.map((issue) => issue.code)).toEqual(['PARTY']);
  });
});
