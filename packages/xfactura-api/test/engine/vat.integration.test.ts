import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A VAT payer (monthly unless `quarterly`) with ANAF as a partner. */
async function company(options: { quarterly?: boolean } = {}) {
  const s = await scenario();
  open.push(s);
  const record = async (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await record('vat.status', 'normal_vat');
  if (options.quarterly) await record('vat.period', 'quarterly');
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const { id: evidenceId } = await s.evidence('decont-tva.pdf');
  const book = async (input: XmlInput, account: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml(input)).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    return s.book('invoices.recognize', { documentId: document.id, account });
  };
  const settlement = (period: string, date: string, round?: number) => ({
    period,
    date,
    authorityId: anaf.id,
    evidenceId,
    ...(round ? { round } : {}),
  });
  const settle = (period: string, date: string, round?: number) =>
    s.propose('vat.settle', settlement(period, date, round));
  return { s, anaf, book, settle, settlement };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const balance = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('VAT settlement', () => {
  test('clears output and deductible VAT into VAT payable to the authority', async () => {
    const { s, book, settle } = await company();
    await book({ number: 'V-1', direction: 'sale' }, '704');
    await book({ number: 'F-1', net: '50.00', tax: '10.50', gross: '60.50' }, '628');
    const proposal = await settle('2026-10', '2026-10-31');
    expect(lines(proposal)).toEqual(['D 4427 21.00', 'C 4426 10.50', 'C 4423 10.50']);
    await s.post(await s.approve(proposal));
    expect(await balance(s, '4427')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await balance(s, '4426')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await balance(s, '4423')).toEqual({ debit: '0.00', credit: '10.50' });
    const [item] = await s.invoke<{ kind: string; balance: string }[]>(s.owner, 'openItems.list', {
      kind: 'tax.payable',
    });
    expect(item).toMatchObject({ kind: 'tax.payable' });
  });

  test('a period with more deductible VAT ends with VAT to recover', async () => {
    const { book, settle } = await company();
    await book({ number: 'F-2' }, '628');
    expect(lines(await settle('2026-10', '2026-10-31'))).toEqual(['C 4426 21.00', 'D 4424 21.00']);
  });

  test('an invoice reaching the period after approval makes the settlement stale', async () => {
    const { s, book, settle } = await company();
    await book({ number: 'V-2', direction: 'sale' }, '704');
    const approved = await s.approve(await settle('2026-10', '2026-10-31'));
    await book({ number: 'V-3', direction: 'sale', date: '2026-10-20' }, '704');
    expect((await s.refused(s.post(approved)))?.code).toBe('STALE');
  });

  test('a later round settles only what reached the period after the first', async () => {
    const { s, book, settle } = await company();
    await book({ number: 'V-4', direction: 'sale' }, '704');
    await s.post(await s.approve(await settle('2026-10', '2026-10-31')));
    await book(
      {
        number: 'V-5',
        direction: 'sale',
        date: '2026-10-25',
        net: '10.00',
        tax: '2.10',
        gross: '12.10',
      },
      '704',
    );
    expect((await s.refused(settle('2026-10', '2026-11-02')))?.code).toBeDefined();
    expect(lines(await settle('2026-10', '2026-11-02', 2))).toEqual(['D 4427 2.10', 'C 4423 2.10']);
  });

  test("follows the company's VAT period and refuses settling early or nothing", async () => {
    const quarterly = await company({ quarterly: true });
    await quarterly.book({ number: 'V-6', direction: 'sale', date: '2026-11-05' }, '704');
    expect(codes(await quarterly.settle('2026-11', '2026-11-30'))).toContain('VAT_PERIOD');
    const early = await quarterly.settle('2026-Q4', '2026-12-15');
    expect(codes(early)).toContain('SETTLEMENT_DATE');
    const revised = await quarterly.s.revise(
      'vat.settle',
      early,
      quarterly.settlement('2026-Q4', '2026-12-31'),
    );
    expect(lines(revised)).toEqual(['D 4427 21.00', 'C 4423 21.00']);
    const empty = await company();
    expect(codes(await empty.settle('2026-09', '2026-09-30'))).toContain('NOTHING_TO_SETTLE');
  });
});
