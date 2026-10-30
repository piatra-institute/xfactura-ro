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
    return { ...document, evidenceId: id };
  };
  return { s, invoice };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const closing = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('deferrals (471, 472)', () => {
  test('an expense and a revenue for later months, released month by month, a missed month caught up', async () => {
    const { s, invoice } = await company();
    // A yearly software subscription bought in October, and a customer's six-month subscription
    // billed in November.
    const bought = await invoice(
      { number: 'F-SAAS', date: '2026-10-15', net: '1200.00', tax: '252.00', gross: '1452.00' },
      '628',
    );
    const defer = (input: Record<string, unknown>) => s.propose('deferrals.defer', input);
    const expense = await defer({
      date: '2026-10-31',
      account: '628',
      amount: '1200.00',
      from: '2026-10',
      months: 12,
      partyId: bought.partyId,
      documentId: bought.id,
      evidenceId: bought.evidenceId,
    });
    expect(lines(expense)).toEqual(['D 471 1200.00', 'C 628 1200.00']);
    await s.post(await s.approve(expense));
    const sold = await invoice(
      {
        number: 'V-ANUAL',
        direction: 'sale',
        date: '2026-11-02',
        net: '600.00',
        tax: '126.00',
        gross: '726.00',
      },
      '704',
    );
    const revenue = await defer({
      date: '2026-11-30',
      account: '704',
      amount: '600.00',
      from: '2026-11',
      months: 6,
      partyId: sold.partyId,
      documentId: sold.id,
      evidenceId: sold.evidenceId,
    });
    expect(lines(revenue)).toEqual(['D 704 600.00', 'C 472 600.00']);
    await s.post(await s.approve(revenue));

    const release = (month: string, round?: number) =>
      s.propose('deferrals.release', { month, ...(round ? { round } : {}) });
    const october = await release('2026-10');
    expect(lines(october)).toEqual(['D 628 100.00', 'C 471 100.00']);
    await s.post(await s.approve(october));
    // November cannot close while its releases are due.
    const findings = async (month: string) =>
      ((await s.close(month)).preview as { findings: { code: string }[] }).findings.map(
        (item) => item.code,
      );
    expect(await findings('2026-11')).toContain('DEFERRAL_DUE');
    // November is not released: December catches it up, for both.
    const december = await release('2026-12');
    expect(lines(december)?.sort()).toEqual([
      'C 471 200.00',
      'C 704 200.00',
      'D 472 200.00',
      'D 628 200.00',
    ]);
    await s.post(await s.approve(december));
    expect((await release('2026-12', 2)).issues.map((issue) => issue.code)).toEqual([
      'NOTHING_TO_RELEASE',
    ]);
    expect(await findings('2026-12')).not.toContain('DEFERRAL_DUE');
    expect(await closing(s, '471')).toEqual({ debit: '900.00', credit: '0.00' });
    expect(await closing(s, '472')).toEqual({ debit: '0.00', credit: '400.00' });
    // 1,200 lei bought, 900 still deferred: 300 lei of expense for three months.
    expect(await closing(s, '628')).toEqual({ debit: '300.00', credit: '0.00' });
  });

  test('a deferral starts releasing in its own month or later', async () => {
    const { s, invoice } = await company();
    const bought = await invoice(
      { number: 'F-ASIG', date: '2026-10-15', net: '1200.00', tax: '252.00', gross: '1452.00' },
      '628',
    );
    const proposal = await s.propose('deferrals.defer', {
      date: '2026-10-31',
      account: '628',
      amount: '1200.00',
      from: '2026-09',
      months: 12,
      partyId: bought.partyId,
      evidenceId: bought.evidenceId,
    });
    expect(proposal.issues.map((issue) => issue.code)).toEqual(['FROM']);
  });
});
