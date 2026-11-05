import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A year with 10,000 lei of share capital, a 10,000-lei sale and a 2,000-lei purchase. */
async function year() {
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
      (await s.evidence('balanta-deschidere.pdf')).id,
      [
        { account: '5121', side: 'D', amount: '10000.00' },
        { account: '1012', side: 'C', amount: '10000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const invoice = async (number: string, extra: Record<string, string>, account: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ number, date: '2026-11-10', ...extra })).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    await s.book('invoices.recognize', { documentId: document.id, account });
  };
  await invoice(
    'V-1',
    { direction: 'sale', net: '10000.00', tax: '2100.00', gross: '12100.00' },
    '704',
  );
  await invoice('F-1', { net: '2000.00', tax: '420.00', gross: '2420.00' }, '628');
  const note = async () => (await s.evidence('nota-inchidere.pdf')).id;
  return { s, note };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const closing = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('year-end', () => {
  test('the result is closed into 121, the legal reserve set aside, and the result carried to 1171 once approved', async () => {
    const { s, note } = await year();
    const result = await s.propose('year.closeResult', {
      yearEnd: '2026-12-31',
      evidenceId: await note(),
    });
    expect(lines(result)).toEqual(['C 628 2000.00', 'D 704 10000.00', 'C 121 8000.00']);
    await s.post(await s.approve(result));
    expect(await closing(s, '704')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await closing(s, '121')).toEqual({ debit: '0.00', credit: '8000.00' });
    // A year's result is closed once.
    expect(
      (
        await s.refused(
          s.propose('year.closeResult', { yearEnd: '2026-12-31', evidenceId: await note() }),
        )
      )?.code,
    ).toBe('SUBJECT_EXISTS');

    // 5% of 8,000 is 400, within a fifth of the 10,000-lei capital.
    const short = await s.propose('year.legalReserve', {
      yearEnd: '2026-12-31',
      amount: '100.00',
      evidenceId: await note(),
    });
    expect(short.issues.map((issue) => issue.code)).toEqual(['LEGAL_RESERVE']);
    const reserve = await s.revise('year.legalReserve', short, {
      yearEnd: '2026-12-31',
      amount: '400.00',
      evidenceId: await note(),
    });
    expect(reserve.issues).toEqual([]);
    expect(lines(reserve)).toEqual(['D 129 400.00', 'C 1061 400.00']);
    await s.post(await s.approve(reserve));

    await s.invoke(s.owner, 'years.create', {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    const decision = (await s.evidence('hotarare-aga-2027.pdf')).id;
    const transfer = await s.propose('year.transferResult', {
      yearEnd: '2026-12-31',
      date: '2027-04-15',
      evidenceId: decision,
    });
    expect(lines(transfer)).toEqual([
      'D 121 400.00',
      'C 129 400.00',
      'D 121 7600.00',
      'C 1171 7600.00',
    ]);
    await s.post(await s.approve(transfer));
    // The retained profit can now be distributed.
    const person = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Popescu Ana',
    });
    const dividends = await s.propose('dividends.distribute', {
      date: '2027-04-20',
      evidenceId: decision,
      shareholders: [{ partyId: person.id, amount: '7600.00' }],
    });
    expect(dividends.issues).toEqual([]);
  });

  test('the legal reserve reads the year’s own result, not the previous year’s moved out of 121', async () => {
    const { s, note } = await year();
    await s.book('year.closeResult', { yearEnd: '2026-12-31', evidenceId: await note() });
    await s.invoke(s.owner, 'years.create', {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    // 2026's 8,000 leaves 121 in April (Dr 121 / Cr 1171); 2027 earns 3,000.
    await s.book('year.transferResult', {
      yearEnd: '2026-12-31',
      date: '2027-04-15',
      evidenceId: (await s.evidence('hotarare-aga-2027.pdf')).id,
    });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('incasare-2027.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '3000.00' },
          { account: '704', side: 'C', amount: '3000.00' },
        ],
        { date: '2027-06-30' },
      ),
    );
    await s.book('year.closeResult', { yearEnd: '2027-12-31', evidenceId: await note() });
    // 121's turnover over 2027 is a 5,000 loss; the year's result is the 3,000 its closing
    // brought: 5% is 150.
    const short = await s.propose('year.legalReserve', {
      yearEnd: '2027-12-31',
      amount: '100.00',
      evidenceId: await note(),
    });
    expect(short.issues.map((issue) => issue.code)).toEqual(['LEGAL_RESERVE']);
    expect(short.issues[0]!.message).toContain('150.00 lei');
    const reserve = await s.revise('year.legalReserve', short, {
      yearEnd: '2027-12-31',
      amount: '150.00',
      evidenceId: await note(),
    });
    expect(reserve.issues).toEqual([]);
    expect(lines(reserve)).toEqual(['D 129 150.00', 'C 1061 150.00']);
  });

  test('refuses a date that does not end the financial year, and a reserve without a closed profit', async () => {
    const { s, note } = await year();
    expect(
      (
        await s.propose('year.closeResult', { yearEnd: '2026-11-30', evidenceId: await note() })
      ).issues.map((issue) => issue.code),
    ).toEqual(['YEAR_END']);
    expect(
      (
        await s.propose('year.legalReserve', {
          yearEnd: '2026-12-31',
          amount: '400.00',
          evidenceId: await note(),
        })
      ).issues.map((issue) => issue.code),
    ).toEqual(['NO_PROFIT']);
  });
});

describe('statutory registers', () => {
  test('Registrul-jurnal names each justifying document; Cartea mare and Registrul-inventar add up', async () => {
    const { s } = await year();
    const journal = await s.invoke<{
      entries: {
        description: string;
        document: { type: string; number: string | null; date: string };
      }[];
    }>(s.owner, 'ledger.journal', { from: '2026-11-01', to: '2026-11-30' });
    expect(journal.entries.map((entry) => entry.document)).toEqual([
      { type: 'Factură emisă', number: 'V-1', date: '2026-11-10' },
      { type: 'Factură primită', number: 'F-1', date: '2026-11-10' },
    ]);

    type Sheet = {
      account: string;
      opening: { debit: string; credit: string };
      debit: { correspondent: string; amount: string }[];
      credit: { correspondent: string; amount: string }[];
      closing: { debit: string; credit: string };
    };
    const ledger = await s.list<Sheet>(s.owner, 'ledger.generalLedger', { month: '2026-11' });
    const sheet = (account: string) => ledger.find((item) => item.account === account)!;
    expect(sheet('704')).toMatchObject({
      credit: [{ correspondent: '4111', amount: '10000.00' }],
      closing: { debit: '0.00', credit: '10000.00' },
    });
    expect(sheet('4111').debit).toEqual([{ correspondent: '% (4427, 704)', amount: '12100.00' }]);
    expect(sheet('5121')).toMatchObject({
      opening: { debit: '10000.00', credit: '0.00' },
      debit: [],
    });

    const inventory = await s.list<{
      account: string;
      balance: { debit: string; credit: string };
      items: { description: string }[];
    }>(s.owner, 'ledger.inventoryRegister', { date: '2026-12-31' });
    expect(inventory.map((row) => row.account)).toEqual([
      '1012',
      '401',
      '4111',
      '4426',
      '4427',
      '5121',
    ]);
    expect(inventory.find((row) => row.account === '4111')).toMatchObject({
      balance: { debit: '12100.00', credit: '0.00' },
      items: [{ description: 'Companie 87654321' }],
    });
  });
});
