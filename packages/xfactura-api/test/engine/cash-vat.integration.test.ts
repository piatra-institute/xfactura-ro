import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { FakeTaxpayers } from './fakes/anaf-taxpayers';
import { camt, camtEntry, iban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { service, type Issued } from './fixtures/sales';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

// Official tests run with ANAF's kits and Java, and are skipped (never passed) without them.
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const saftDist = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const java = Bun.which('java') !== null;
const official = DukIntegrator.available(dist) && java ? test : test.skip;
const officialSaft = DukIntegrator.available(saftDist) && java ? test : test.skip;

// Synthetic company and partners (CUIs with valid control digits); amounts by hand:
//   XF0001: 1,000.00 + 21% = 1,210.00. Collected 500.00 in cash on 20 October:
//     210.00 × 500 / 1,210 = 86.776… → 86.78 (base 1,000 × 500 / 1,210 = 413.22); the remaining
//     710.00 by bank on 10 November releases 210.00 − 86.78 = 123.22 (base 586.78).
//   F-1: 100.00 + 21.00 from a supplier outside the system, paid in cash: the deduction of 21.00
//     waits for the payment (art. 297 alin. (3)).
const cui = '18547290';
const customer = '14399840';
const supplier = '26000020';
const otherSupplier = '31552803';
type Movement = { id: string; amount: string; reference: string };
type Artifact = {
  id: string;
  state: string;
  steps: { state: string; detail: string | null; evidenceId: string | null }[];
};
type Item = { id: string; partyId: string; document: string | null; balance: string };

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const taxes = (proposal: ProposalView) =>
  proposal.effect?.taxEntries.map(
    (entry) =>
      `${entry.code} ${entry.base}/${entry.amount}/${entry.booked} ${entry.exigibility ?? 'neexigibil'} ${entry.taxPeriod}`,
  );
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const findings = (action: { preview: unknown }) =>
  (action.preview as { findings: { code: string }[] }).findings.map((finding) => finding.code);

/** A VAT payer, monthly, applying VAT on collection from 1 January 2026 unless `cash` is false,
 * with its invoicing details, series XF, a cash desk and a bank account opened at 5,000.00. */
async function company(cash = true, validator?: DeclarationValidator) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  const fact = async (axis: string, value: string, effectiveFrom = '2026-01-01') =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom,
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await fact('vat.status', 'normal_vat');
  await fact('vat.period', 'monthly');
  await fact('vat.cash', cash ? 'yes' : 'no');
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('balanta-deschidere.pdf')).id,
      [
        { account: '5121', side: 'D', amount: '5000.00' },
        { account: '1012', side: 'C', amount: '5000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const buyer = await s.party('Client Unu SRL', customer);
  await s.invoke(s.owner, 'parties.recordDetails', {
    partyId: buyer.id,
    details: {
      name: 'Client Unu SRL',
      vatId: `RO${customer}`,
      address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
    },
  });
  const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
    code: 'XF',
    prefix: 'XF',
    width: 4,
    revenueAccount: '704',
  });
  /** Issues an invoice from series XF and posts its recognition. */
  const sell = async (issueDate: string, price: string, extra: Record<string, unknown> = {}) => {
    const issued = await s.invoke<Issued>(s.owner, 'sales.issue', {
      seriesId: series.id,
      buyerId: buyer.id,
      issueDate,
      lines: [service(price)],
      ...extra,
    });
    const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: issued.recognition.proposalId,
    });
    return { issued, posted: await s.post(await s.approve(proposal)) };
  };
  /** Imports an invoice the company received (or issued elsewhere); a partner it creates gets
   * its invoicing details. */
  const document = async (input: XmlInput) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ company: cui, ...input })).toString('base64'),
    });
    const imported = await s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: id,
    });
    const code = (input.counterparty ?? '').replace(/^RO/, '');
    if (imported.partyId !== buyer.id)
      await s.invoke(s.owner, 'parties.recordDetails', {
        partyId: imported.partyId,
        details: {
          name: `Companie ${input.counterparty}`,
          vatId: `RO${code}`,
          address: {
            lines: ['Str. Mare 1'],
            city: 'Cluj-Napoca',
            subdivision: 'RO-CJ',
            country: 'RO',
          },
        },
      });
    return imported;
  };
  const item = async (number: string) =>
    (await s.list<Item>(s.owner, 'openItems.list', {})).find((open) => open.document === number)!;
  /** A cash receipt or payment settling an invoice. */
  const cashDesk = async (
    direction: 'receipt' | 'payment',
    number: string,
    invoice: string,
    amount: string,
    date: string,
  ) => {
    const settled = await item(invoice);
    return s.propose('cash.record', {
      account: '5311',
      date,
      direction,
      number,
      partyId: settled.partyId,
      evidenceId: (await s.evidence(`${number}.pdf`)).id,
      allocations: [{ openItem: settled.id, amount }],
    });
  };
  /** Imports a statement of the given entries (opening 5,000.00) and returns its movements. */
  const statement = async (entries: Parameters<typeof camtEntry>[0][], closing: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        camt({
          opening: '5000.00',
          closing,
          from: '2026-10-01',
          to: '2026-12-31',
          entries: entries.map(camtEntry).join(''),
        }),
      ).toString('base64'),
    });
    await s.invoke(s.owner, 'bank.import', { evidenceId: id, financialYearId: s.year.id });
    return s.list<Movement>(s.owner, 'bank.movements', {});
  };
  return { s, fact, sell, document, item, cashDesk, statement, buyer };
}

describe('VAT on collection, a company applying it', () => {
  test('a sale waits on 4428 and each collection releases its share in its own period', async () => {
    const { s, sell, cashDesk, statement, item } = await company();
    const { issued, posted } = await sell('2026-10-05', '1000');
    const xml = new TextDecoder().decode(
      (await s.engine.evidence.read(s.owner, issued.evidenceId)).bytes,
    );
    expect(xml).toContain('<cbc:Note>TVA la încasare</cbc:Note>');
    expect(codes(posted)).toEqual([]);
    expect(lines(posted)).toEqual(['D 4111 1210.00', 'C 704 1000.00', 'C 4428 210.00']);
    expect(taxes(posted)).toEqual(['S-21 1000.00/210.00/210.00 neexigibil 2026-10']);
    expect(posted.effect!.taxEntries[0]!.attributes.cashVat).toBe('own');

    const receipt = await cashDesk('receipt', 'CH-1', 'XF0001', '500.00', '2026-10-20');
    expect(codes(receipt)).toEqual([]);
    expect(lines(receipt)).toEqual([
      'D 5311 500.00',
      'C 4111 500.00',
      'D 4428 86.78',
      'C 4427 86.78',
    ]);
    expect(taxes(receipt)).toEqual([
      'S-21 -413.22/-86.78/-86.78 neexigibil 2026-10',
      'S-21 413.22/86.78/86.78 2026-10-20 2026-10',
    ]);
    await s.post(await s.approve(receipt));

    const movements = await statement(
      [
        {
          amount: '710.00',
          bankRef: 'IN-1',
          date: '2026-11-10',
          direction: 'CRDT',
          text: 'XF0001',
        },
      ],
      '5710.00',
    );
    const collected = await s.book('bank.settle', {
      movementId: movements.find((movement) => movement.amount === '710.00')!.id,
      allocations: [{ openItem: (await item('XF0001')).id, amount: '710.00' }],
    });
    expect(lines(collected)).toEqual([
      'D 5121 710.00',
      'C 4111 710.00',
      'D 4428 123.22',
      'C 4427 123.22',
    ]);
    expect(taxes(collected)).toEqual([
      'S-21 -586.78/-123.22/-123.22 neexigibil 2026-11',
      'S-21 586.78/123.22/123.22 2026-11-10 2026-11',
    ]);
    const balance = await s.trialBalance();
    const closing = (account: string) =>
      balance.rows.find((row) => row.account === account)?.closing;
    expect(closing('4428')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(closing('4427')).toEqual({ debit: '0.00', credit: '210.00' });
    // October's settlement clears only what became chargeable in October.
    const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'ANAF',
    });
    const settled = await s.propose('vat.settle', {
      period: '2026-10',
      date: '2026-11-25',
      authorityId: anaf.id,
      evidenceId: (await s.evidence('decont-octombrie.pdf')).id,
    });
    expect(lines(settled)).toEqual(['D 4427 86.78', 'C 4423 86.78']);
  });
});

describe('VAT on collection, corrections and purchases', () => {
  test('a credit note reduces the deferred VAT first, and the rest is released by the collections', async () => {
    // XF0001: 5,000.00 + 1,050.00. Collected 2,420.00: 1,050 × 2,420 / 6,050 = 420.00 (base
    // 2,000.00). The credit note XF0002 of 500.00 + 105.00 takes 105.00 off the 630.00 still
    // deferred; the remaining 3,025.00 collected releases the 525.00 left (base 2,500.00).
    const { s, sell, cashDesk, statement, item } = await company();
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('cec.pdf')).id,
        [
          { account: '5311', side: 'D', amount: '100.00' },
          { account: '5121', side: 'C', amount: '100.00' },
        ],
        { date: '2026-10-01' },
      ),
    );
    const { issued } = await sell('2026-10-05', '5000');
    const receipt = await cashDesk('receipt', 'CH-1', 'XF0001', '2420.00', '2026-10-10');
    expect(taxes(receipt)).toEqual([
      'S-21 -2000.00/-420.00/-420.00 neexigibil 2026-10',
      'S-21 2000.00/420.00/420.00 2026-10-10 2026-10',
    ]);
    await s.post(await s.approve(receipt));
    const { posted: credit } = await sell('2026-11-03', '500', {
      typeCode: '381',
      precedingDocumentIds: [issued.documentId],
    });
    expect(codes(credit)).toEqual([]);
    expect(lines(credit)).toEqual(['D 4111 -605.00', 'C 704 -500.00', 'C 4428 -105.00']);
    expect(taxes(credit)).toEqual(['S-21 -500.00/-105.00/-105.00 neexigibil 2026-11']);
    const movements = await statement(
      [{ amount: '3025.00', bankRef: 'IN-2', date: '2026-12-02', direction: 'CRDT' }],
      '8025.00',
    );
    const collected = await s.book('bank.settle', {
      movementId: movements.find((movement) => movement.amount === '3025.00')!.id,
      allocations: [{ openItem: (await item('XF0001')).id, amount: '3025.00' }],
    });
    expect(taxes(collected)).toEqual([
      'S-21 -2500.00/-525.00/-525.00 neexigibil 2026-12',
      'S-21 2500.00/525.00/525.00 2026-12-02 2026-12',
    ]);
    const balance = await s.trialBalance();
    expect(balance.rows.find((row) => row.account === '4428')?.closing).toEqual({
      debit: '0.00',
      credit: '0.00',
    });
  });

  test('a reversed collection puts its VAT back on 4428, for the next collection to release', async () => {
    const { s, sell, cashDesk } = await company();
    await sell('2026-10-05', '1000');
    const receipt = await s.post(
      await s.approve(await cashDesk('receipt', 'CH-1', 'XF0001', '500.00', '2026-10-20')),
    );
    const reversed = await s.book('ledger.reverse', {
      entryId: receipt.entry!.id,
      date: '2026-11-02',
      reason: 'Chitanța a fost anulată.',
      evidenceId: (await s.evidence('anulare.pdf')).id,
      method: 'red',
    });
    expect(taxes(reversed)).toEqual([
      'S-21 413.22/86.78/86.78 neexigibil 2026-11',
      'S-21 -413.22/-86.78/-86.78 2026-11-02 2026-11',
    ]);
    const again = await cashDesk('receipt', 'CH-2', 'XF0001', '1210.00', '2026-11-05');
    expect(taxes(again)).toEqual([
      'S-21 -1000.00/-210.00/-210.00 neexigibil 2026-11',
      'S-21 1000.00/210.00/210.00 2026-11-05 2026-11',
    ]);
  });

  test('purchases defer their deduction until paid, whoever applies the system', async () => {
    const { s, document, cashDesk } = await company();
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('cec.pdf')).id,
        [
          { account: '5311', side: 'D', amount: '500.00' },
          { account: '5121', side: 'C', amount: '500.00' },
        ],
        { date: '2026-10-01' },
      ),
    );
    const own = await document({
      number: 'F-1',
      counterparty: `RO${supplier}`,
      date: '2026-10-02',
    });
    const both = await document({
      number: 'F-2',
      counterparty: `RO${otherSupplier}`,
      date: '2026-10-03',
      note: 'TVA la incasare',
    });
    const none = await document({
      number: 'F-3',
      counterparty: `RO${supplier}`,
      date: '2026-10-04',
    });
    const first = await s.book('invoices.recognize', { documentId: own.id, account: '628' });
    expect(lines(first)).toEqual(['D 628 100.00', 'D 4428 21.00', 'C 401 121.00']);
    expect(taxes(first)).toEqual(['S-21 100.00/21.00/21.00 neexigibil 2026-10']);
    expect(first.effect!.taxEntries[0]!.attributes.cashVat).toBe('own');
    const second = await s.book('invoices.recognize', { documentId: both.id, account: '628' });
    expect(second.effect!.taxEntries[0]!.attributes.cashVat).toBe('own+supplier');
    // Non-deductible VAT is not deferred (norme pct. 67 alin. (8)).
    const third = await s.book('invoices.recognize', {
      documentId: none.id,
      account: '628',
      deduction: 'none',
    });
    expect(lines(third)).toEqual(['D 628 121.00', 'C 401 121.00']);
    expect(taxes(third)).toEqual(['S-21 100.00/21.00/0.00 2026-10-04 2026-10']);

    const paid = await cashDesk('payment', 'DP-1', 'F-1', '60.50', '2026-10-15');
    expect(lines(paid)).toEqual(['C 5311 60.50', 'D 401 60.50', 'D 4426 10.50', 'C 4428 10.50']);
    expect(taxes(paid)).toEqual([
      'S-21 50.00/10.50/10.50 2026-10-15 2026-10',
      'S-21 -50.00/-10.50/-10.50 neexigibil 2026-10',
    ]);
  });

  test('an invoice issued before the company enters the system stays outside it, in quarters too', async () => {
    // Under the system from 1 November, quarterly: V-1, issued on 28 October for a supply of
    // 5 November, follows the rules it was issued under (art. 282 alin. (7) lit. a)).
    const { s, fact, sell, document } = await company(false);
    await fact('vat.cash', 'yes', '2026-11-01');
    await fact('vat.period', 'quarterly');
    const early = await document({
      direction: 'sale',
      number: 'V-1',
      counterparty: `RO${customer}`,
      date: '2026-10-28',
      taxPointDate: '2026-11-05',
    });
    const before = await s.book('invoices.recognize', { documentId: early.id, account: '704' });
    expect(lines(before)).toEqual(['D 4111 121.00', 'C 704 100.00', 'C 4427 21.00']);
    expect(taxes(before)).toEqual(['S-21 100.00/21.00/21.00 2026-11-05 2026-Q4']);
    const { posted } = await sell('2026-11-02', '100');
    expect(taxes(posted)).toEqual(['S-21 100.00/21.00/21.00 neexigibil 2026-Q4']);
  });

  test('an affiliated customer is invoiced under the general rules', async () => {
    const { s, sell } = await company();
    const { issued, posted } = await sell('2026-10-05', '100', { affiliated: true });
    const xml = new TextDecoder().decode(
      (await s.engine.evidence.read(s.owner, issued.evidenceId)).bytes,
    );
    expect(xml).not.toContain('TVA la încasare');
    expect(lines(posted)).toEqual(['D 4111 121.00', 'C 704 100.00', 'C 4427 21.00']);
    expect(taxes(posted)).toEqual(['S-21 100.00/21.00/21.00 2026-10-05 2026-10']);
  });

  test('a company outside the system buying from a supplier in it deducts when it pays', async () => {
    const { s, document, statement, item } = await company(false);
    const bought = await document({
      number: 'F-10',
      counterparty: `RO${supplier}`,
      date: '2026-10-02',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
      note: 'Plata la 30 de zile # TVA la încasare',
    });
    const posted = await s.book('invoices.recognize', { documentId: bought.id, account: '628' });
    expect(lines(posted)).toEqual(['D 628 1000.00', 'D 4428 210.00', 'C 401 1210.00']);
    expect(posted.effect!.taxEntries[0]!.attributes.cashVat).toBe('supplier');
    const movements = await statement(
      [{ amount: '1210.00', bankRef: 'OUT-1', date: '2026-11-04', text: 'F-10' }],
      '3790.00',
    );
    const paid = await s.book('bank.settle', {
      movementId: movements.find((movement) => movement.amount === '-1210.00')!.id,
      allocations: [{ openItem: (await item('F-10')).id, amount: '1210.00' }],
    });
    expect(lines(paid)).toEqual([
      'C 5121 1210.00',
      'D 401 1210.00',
      'D 4426 210.00',
      'C 4428 210.00',
    ]);
    expect(taxes(paid)).toEqual([
      'S-21 1000.00/210.00/210.00 2026-11-04 2026-11',
      'S-21 -1000.00/-210.00/-210.00 neexigibil 2026-11',
    ]);
  });

  test("ANAF's register on the tax point defers the deduction even without the mention", async () => {
    const fake = new FakeTaxpayers()
      .taxpayer('87654321', { cashVat: true })
      .taxpayer('26000039', { cashVat: false });
    const s = await scenario({ taxpayers: fake, clock: () => Date.parse('2026-10-30T09:00:00Z') });
    open.push(s);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'vat.status',
      value: 'normal_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence('certificat.pdf')).id,
    });
    const imported = async (input: XmlInput) =>
      s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: (
          await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
            filename: `${input.number}.xml`,
            mediaType: 'application/xml',
            base64: Buffer.from(invoiceXml(input)).toString('base64'),
          })
        ).id,
      });
    const registered = await imported({ number: 'F-1', date: '2026-10-01' });
    const mentioned = await imported({
      number: 'F-2',
      date: '2026-10-02',
      counterparty: '26000039',
      note: 'TVA la încasare',
    });
    await s.invoke(s.owner, 'parties.checkStatus', { month: '2026-10' });
    const first = await s.book('invoices.recognize', { documentId: registered.id, account: '628' });
    expect(lines(first)).toEqual(['D 628 100.00', 'D 4428 21.00', 'C 401 121.00']);
    expect(first.effect!.taxEntries[0]!.attributes.cashVat).toBe('supplier');
    // The mention without the register: deferred as the invoice says, for the reviewer to check.
    const second = await s.propose('invoices.recognize', {
      documentId: mentioned.id,
      account: '628',
    });
    expect(codes(second)).toEqual(['CASH_VAT_SUPPLIER']);
    expect(lines(second)).toEqual(['D 628 100.00', 'D 4428 21.00', 'C 401 121.00']);
  });

  test('refuses what it cannot release: other movements on the invoice, and foreign currency', async () => {
    const { s, sell, document, cashDesk, item } = await company();
    await sell('2026-10-05', '100');
    // A write-off by general journal leaves the VAT deferred: the next collection is refused,
    // and the month's close warns about the invoice settled with VAT still on 4428.
    const settled = await item('XF0001');
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('proces-verbal.pdf')).id,
        [
          { account: '654', side: 'D', amount: '21.00' },
          { account: '4111', side: 'C', amount: '21.00', openItem: settled.id },
        ],
        { date: '2026-10-12' },
      ),
    );
    const receipt = await cashDesk('receipt', 'CH-1', 'XF0001', '100.00', '2026-10-20');
    expect(codes(receipt)).toEqual(['CASH_VAT_MOVEMENT']);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: receipt.id,
      reason: 'Încasarea a fost refuzată.',
    });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('proces-verbal-2.pdf')).id,
        [
          { account: '654', side: 'D', amount: '100.00' },
          { account: '4111', side: 'C', amount: '100.00', openItem: settled.id },
        ],
        { date: '2026-10-13' },
      ),
    );
    const close = await s.close('2026-10');
    expect(findings(close)).toContain('CASH_VAT_UNRELEASED');
    const foreign = await document({
      number: 'F-EUR',
      counterparty: `RO${supplier}`,
      currency: 'EUR',
    });
    const refused = await s.propose('invoices.recognize', {
      documentId: foreign.id,
      account: '628',
    });
    expect(codes(refused)).toContain('CASH_VAT_CURRENCY');
  });
});

const d300Options = {
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  caen: '6201',
  bank: 'Banca Exemplu',
  account: iban,
};
const d394Options = {
  caen: '6201',
  phone: '0236123456',
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați, Str. Lungă 10' },
  preparer: {
    kind: 'company',
    cui: customer,
    name: 'Contabil Exemplu SRL',
    capacity: 'Împuternicit',
  },
  consultation: true,
  affiliates: false,
};
const contact = { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' };
const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail!);
const state = (artifact: Artifact) => [artifact.state, artifact.steps.at(-1)?.detail ?? null];

/**
 * October and November of a company applying VAT on collection: XF0001 (1,000.00 + 210.00)
 * collected 500.00 in cash in October and 710.00 by bank in November; F-1 (100.00 + 21.00) from
 * a supplier outside the system, paid in October; F-2 (200.00 + 42.00) from a supplier applying
 * the system, unpaid.
 */
async function books(cash = true, validator?: DeclarationValidator) {
  const books = await company(cash, validator);
  const { s, sell, document, cashDesk, statement, item } = books;
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('cec.pdf')).id,
      [
        { account: '5311', side: 'D', amount: '300.00' },
        { account: '5121', side: 'C', amount: '300.00' },
      ],
      { date: '2026-10-01' },
    ),
  );
  await sell('2026-10-05', '1000');
  await s.post(
    await s.approve(await cashDesk('receipt', 'CH-1', 'XF0001', '500.00', '2026-10-20')),
  );
  const bought = await document({
    number: 'F-1',
    counterparty: `RO${supplier}`,
    date: '2026-10-02',
  });
  await s.book('invoices.recognize', { documentId: bought.id, account: '628' });
  await s.post(await s.approve(await cashDesk('payment', 'DP-1', 'F-1', '121.00', '2026-10-15')));
  const deferred = await document({
    number: 'F-2',
    counterparty: `RO${otherSupplier}`,
    date: '2026-10-03',
    net: '200.00',
    tax: '42.00',
    gross: '242.00',
    note: 'TVA la încasare',
  });
  await s.book('invoices.recognize', { documentId: deferred.id, account: '628' });
  const movements = await statement(
    [{ amount: '710.00', bankRef: 'IN-1', date: '2026-11-10', direction: 'CRDT', text: 'XF0001' }],
    '5710.00',
  );
  await s.book('bank.settle', {
    movementId: movements.find((movement) => movement.amount === '710.00')!.id,
    allocations: [{ openItem: (await item('XF0001')).id, amount: '710.00' }],
  });
  const prepare = (kind: string, period: string, options: unknown) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period, options });
  return { ...books, prepare };
}

describe('VAT on collection at the month close', () => {
  test('warns when the company leaves the system during the year', async () => {
    const { s, fact } = await company();
    await fact('vat.cash', 'no', '2026-10-15');
    expect(findings(await s.close('2026-10'))).toContain('CASH_VAT_EXIT');
  });

  test('warns when the turnover of the year exceeds the ceiling of the system', async () => {
    // 5,000,100.00 + 1,050,021.00 collected by bank: the base declared, above 5,000,000.00.
    const { s, sell, statement, item } = await company();
    await sell('2026-10-05', '5000100');
    const movements = await statement(
      [{ amount: '6050121.00', bankRef: 'IN-1', date: '2026-10-25', direction: 'CRDT' }],
      '6055121.00',
    );
    await s.book('bank.settle', {
      movementId: movements.find((movement) => movement.amount === '6050121.00')!.id,
      allocations: [{ openItem: (await item('XF0001')).id, amount: '6050121.00' }],
    });
    expect(findings(await s.close('2026-10'))).toContain('CASH_VAT_CEILING');
  });

  test('counts only supplies toward the ceiling, never the VAT the company self-assesses as a buyer', async () => {
    // 5,000,100.00 of ferrous waste bought under the domestic reverse charge (art. 331): its VAT
    // collected on the acquisition (TI-A-21) is no supply of the company.
    const { s, document } = await company();
    const waste = await document({
      number: 'TI-1',
      date: '2026-10-10',
      counterparty: 'RO13548146',
      category: 'AE',
      rate: '0',
      net: '5000100.00',
      tax: '0.00',
      gross: '5000100.00',
    });
    const proposal = await s.propose('invoices.reverseCharge', {
      documentId: waste.id,
      parts: [{ category: 'waste', account: '6028', amount: '5000100.00' }],
    });
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    await s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
    expect(findings(await s.close('2026-10'))).not.toContain('CASH_VAT_CEILING');
  });
});

describe('VAT on collection in the declarations', () => {
  test('D300 declares what was collected and paid, and what stays deferred', async () => {
    const { prepare } = await books();
    const october = await prepare('D300', '2026-10', d300Options);
    expect(summary(october).rows).toEqual({
      R9_1: 413,
      R9_2: 87,
      R22_1: 100,
      R22_2: 21,
      R28_2: 21,
      valoare_a: 587,
      tva_a: 123,
      valoare_a1: 587,
      tva_a1: 123,
      valoare_b: 200,
      tva_b: 42,
      valoare_b1: 200,
      tva_b1: 42,
    });
    const november = await prepare('D300', '2026-11', d300Options);
    expect(summary(november).rows).toEqual({
      R9_1: 587,
      R9_2: 123,
      valoare_b: 200,
      tva_b: 42,
      valoare_b1: 200,
      tva_b1: 42,
    });
  });

  test('D394 lists the invoices in full and the VAT collected and deducted on payment', async () => {
    const { prepare } = await books();
    const october = summary(await prepare('D394', '2026-10', d394Options));
    expect(october.operations).toEqual([
      { type: 'L', rate: '21', partner: customer, invoices: 1, base: 1000, vat: 210 },
      { type: 'A', rate: '21', partner: supplier, invoices: 1, base: 100, vat: 21 },
      { type: 'AI', rate: '21', partner: otherSupplier, invoices: 1, base: 200, vat: 42 },
    ]);
    expect(october.vatOnCollection).toEqual({ collected: { '21': 87 }, deductible: { '21': 21 } });
    const november = summary(await prepare('D394', '2026-11', d394Options));
    expect(november.operations).toEqual([]);
    expect(november.vatOnCollection).toEqual({ collected: { '21': 123 }, deductible: {} });
  });

  test('a company outside the system declares its purchase from one in it when it pays', async () => {
    const { s, document, statement, item } = await company(false);
    const bought = await document({
      number: 'F-10',
      counterparty: `RO${supplier}`,
      date: '2026-10-02',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
      note: 'TVA la încasare',
    });
    await s.book('invoices.recognize', { documentId: bought.id, account: '628' });
    const movements = await statement(
      [{ amount: '1210.00', bankRef: 'OUT-1', date: '2026-11-04', text: 'F-10' }],
      '3790.00',
    );
    await s.book('bank.settle', {
      movementId: movements.find((movement) => movement.amount === '-1210.00')!.id,
      allocations: [{ openItem: (await item('F-10')).id, amount: '1210.00' }],
    });
    const prepare = (kind: string, period: string, options: unknown) =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period, options });
    expect(summary(await prepare('D300', '2026-10', d300Options)).rows).toEqual({
      valoare_b: 1000,
      tva_b: 210,
      valoare_b1: 1000,
      tva_b1: 210,
    });
    expect(summary(await prepare('D300', '2026-11', d300Options)).rows).toEqual({
      R22_1: 1000,
      R22_2: 210,
      R28_2: 210,
    });
    const october = summary(await prepare('D394', '2026-10', d394Options));
    expect(october.operations).toEqual([
      { type: 'AI', rate: '21', partner: supplier, invoices: 1, base: 1000, vat: 210 },
    ]);
    const november = summary(await prepare('D394', '2026-11', d394Options));
    expect([november.cashVatDeductible, november.vatOnCollection]).toEqual([
      { '21': 210 },
      undefined,
    ]);
  });

  official(
    "D300 and D394 of a company applying the system pass ANAF's validator",
    async () => {
      const { prepare } = await books(true, new DukIntegrator(dist));
      for (const period of ['2026-10', '2026-11']) {
        expect(state(await prepare('D300', period, d300Options))).toEqual([
          'validated_official',
          null,
        ]);
        expect(state(await prepare('D394', period, d394Options))).toEqual([
          'validated_official',
          null,
        ]);
      }
    },
    120_000,
  );

  officialSaft(
    "D406 of a company applying the system passes ANAF's SAF-T validator",
    async () => {
      const { sell, prepare } = await books(
        true,
        new AnafKits({ saft: new DukIntegrator(saftDist, saftKitId) }),
      );
      // A periodic file lists at least one product: November gets an invoice of its own.
      await sell('2026-11-20', '300');
      for (const period of ['2026-10', '2026-11'])
        expect(state(await prepare('D406', period, { contact }))).toEqual([
          'validated_official',
          null,
        ]);
    },
    120_000,
  );
});
