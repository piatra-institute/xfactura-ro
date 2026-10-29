import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

// Synthetic BNR file and documents. Every expected amount below is computed by hand:
//   1,000.00 EUR × 4.9765 = 4,976.50; VAT 210.00 EUR × 4.9765 = 1,045.065 → 1,045.07.
//   Receivable 4,976.50 + 1,045.07 = 6,021.57. At 4.9900: 1,210.00 × 4.99 = 6,037.90 (+16.33).
//   Received at 5.0000: 1,210.00 × 5 = 6,050.00 against 6,037.90 carried (+12.10).
const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-04-15</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-03-09"><Rate currency="EUR">4.9700</Rate><Rate currency="HUF" multiplier="100">1.2500</Rate><Rate currency="XAU">500.1234</Rate></Cube>
<Cube date="2026-03-10"><Rate currency="EUR">4.9765</Rate></Cube>
<Cube date="2026-03-31"><Rate currency="EUR">4.9900</Rate></Cube>
<Cube date="2026-04-15"><Rate currency="EUR">5.0000</Rate></Cube>
</Body></DataSet>`;

/** A valid Romanian IBAN for a synthetic bank code (ISO 7064 mod 97-10 check digits). */
function iban(bank: string, account: string) {
  const bban = `${bank}${account}`;
  const digits = `${bban}RO00`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  const check = 98n - (BigInt(digits) % 97n);
  return `RO${String(check).padStart(2, '0')}${bban}`;
}
const eurIban = iban('BBBB', '1B31007593840001');
const statement = (amount: string, date = '0415') => `:20:EUR042026
:25:${eurIban}
:28C:001/001
:60F:C260401EUR0,00
:61:2604${date.slice(2)}${date}C${amount.replace('.', ',')}NTRFEXP-1//EUR-IN-01
:86:Incasare EXP-1
:62F:C260430EUR${amount.replace('.', ',')}`;

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

async function company() {
  const s = await scenario();
  open.push(s);
  const { id: certificate } = await s.evidence('certificat-tva.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: certificate,
  });
  const file = async (filename: string, text: string) =>
    s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename,
      mediaType: 'application/xml',
      base64: Buffer.from(text).toString('base64'),
    });
  const rates = await s.invoke<{ rates: number; added: number; revised: number }>(
    s.owner,
    'fx.importBnr',
    {
      evidenceId: (await file('nbrfxrates.xml', bnr)).id,
    },
  );
  const sale = async (ronVat: string, date = '2026-03-10', number = 'EXP-1') => {
    const xml = invoiceXml({
      direction: 'sale',
      currency: 'EUR',
      number,
      date,
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
    })
      .replace(
        '</cbc:DocumentCurrencyCode>',
        '</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>',
      )
      .replace(
        '<cac:LegalMonetaryTotal>',
        `<cac:TaxTotal><cbc:TaxAmount currencyID="RON">${ronVat}</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>`,
      );
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: (await file(`${number}.xml`, xml)).id,
    });
    return s.propose('invoices.recognize', { documentId: document.id, account: '704' });
  };
  return { s, rates, sale, file };
}
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map(
    (line) =>
      `${line.side} ${line.account} ${line.amount}${line.currency ? ` [${line.currency.code} ${line.currency.amount}]` : ''}`,
  );

describe('BNR rates', () => {
  test('are imported once, without units that are not currencies', async () => {
    const { s, rates, file } = await company();
    expect(rates).toEqual({ rates: 5, added: 5, revised: 0 });
    const again = await s.invoke(s.owner, 'fx.importBnr', {
      evidenceId: (await file('again.xml', bnr)).id,
    });
    expect(again).toEqual({ rates: 5, added: 0, revised: 0 });
    expect(
      await s.invoke(s.owner, 'fx.rates', {
        currency: 'HUF',
        from: '2026-03-01',
        to: '2026-03-31',
      }),
    ).toEqual([
      { date: '2026-03-09', currency: 'HUF', rate: '1.2500', multiplier: 100, revision: 1 },
    ]);
  });
});

describe('foreign-currency invoices', () => {
  test('book at the accounting rate, with VAT in lei as the invoice states', async () => {
    const { sale } = await company();
    const proposal = await sale('1045.07');
    expect(proposal.issues).toEqual([]);
    expect(lines(proposal)).toEqual([
      'D 4111 6021.57 [EUR 1210.00]',
      'C 704 4976.50 [EUR 1000.00]',
      'C 4427 1045.07 [EUR 210.00]',
    ]);
    expect(proposal.effect?.openItems[0]?.currency).toBe('EUR');
    expect(proposal.effect?.taxEntries[0]).toMatchObject({ base: '4976.50', amount: '1045.07' });
    expect(proposal.rules.used.map((rule) => rule.id)).toEqual([
      'ro.fx.rate_date.accounting/2024-01-01',
      'ro.fx.rate_date.vat/2024-01-01',
      'ro.vat.rate/S/2025-08-01',
    ]);
  });

  test('a VAT amount that differs from the BNR rate needs an acknowledged warning', async () => {
    const { s, sale } = await company();
    const proposal = await sale('1045.00');
    expect(proposal.issues.map((issue) => `${issue.severity} ${issue.code}`)).toEqual([
      'ack VAT_FX',
    ]);
    expect((await s.refused(s.approve(proposal)))?.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
    expect((await s.approve(proposal, s.reviewer, ['VAT_FX'])).status).toBe('approved');
  });

  test('a missing rate is a visible gap', async () => {
    const { sale } = await company();
    const proposal = await sale('1045.07', '2026-05-20', 'EXP-5');
    expect(proposal.issues.map((issue) => issue.code)).toEqual(['FX_RATE']);
  });
});

describe('revaluation and settlement', () => {
  async function booked() {
    const context = await company();
    const { s, sale } = context;
    const invoice = await s.post(await s.approve(await sale('1045.07')));
    const receivable = invoice.effect!.openItems[0]!.id;
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont EUR',
      iban: eurIban,
      currency: 'EUR',
      ledgerAccount: '5124',
      openedOn: '2026-01-01',
    });
    return { ...context, receivable };
  }
  async function receive(context: Awaited<ReturnType<typeof booked>>, amount: string) {
    const { s, file } = context;
    await s.invoke(s.owner, 'bank.import', {
      evidenceId: (await file(`extras-${amount}.sta`, statement(amount))).id,
      financialYearId: s.year.id,
    });
    const [movement] = await s.invoke<{ id: string }[]>(s.owner, 'bank.movements', {
      unsettled: true,
    });
    return movement!.id;
  }

  test('month-end revaluation brings the receivable to the closing rate', async () => {
    const { s } = await booked();
    expect(
      ((await s.close('2026-03')).preview as { findings: { code: string; severity: string }[] })
        .findings,
    ).toContainEqual(expect.objectContaining({ code: 'FX_NOT_REVALUED', severity: 'warn' }));
    const revalued = await s.book('fx.revalue', { date: '2026-03-31' });
    expect(lines(revalued)).toEqual(['D 4111 16.33 [EUR 0.00]', 'C 7651 16.33']);
    const early = await s.propose('fx.revalue', { date: '2026-03-30' });
    expect(early.issues.map((issue) => issue.code)).toContain('REVALUATION_DATE');
    const closing = await s.close('2026-03');
    expect(
      (closing.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).not.toContain('FX_NOT_REVALUED');
  });

  test('settling in full realizes the difference and clears the receivable in both currencies', async () => {
    const context = await booked();
    const { s, receivable } = context;
    await s.book('fx.revalue', { date: '2026-03-31' });
    const movementId = await receive(context, '1210.00');
    const settled = await s.book('bank.settle', {
      movementId,
      allocations: [{ openItem: receivable, amount: '1210.00' }],
    });
    expect(lines(settled)).toEqual([
      'D 5124 6050.00 [EUR 1210.00]',
      'C 4111 6037.90 [EUR 1210.00]',
      'C 7651 12.10',
    ]);
    const balance = await s.trialBalance();
    expect(balance.rows.find((row) => row.account === '4111')?.closing).toEqual({
      debit: '0.00',
      credit: '0.00',
    });
    expect(balance.rows.find((row) => row.account === '7651')?.closing).toEqual({
      debit: '0.00',
      credit: '28.43',
    });
  });

  test('a partial settlement releases the carrying amount in proportion', async () => {
    const context = await booked();
    const { s, receivable } = context;
    await s.book('fx.revalue', { date: '2026-03-31' });
    const movementId = await receive(context, '605.00');
    const settled = await s.propose('bank.settle', {
      movementId,
      allocations: [{ openItem: receivable, amount: '605.00' }],
    });
    // Half of 6,037.90 is released; 605.00 × 5 = 3,025.00 is received.
    expect(lines(settled)).toEqual([
      'D 5124 3025.00 [EUR 605.00]',
      'C 4111 3018.95 [EUR 605.00]',
      'C 7651 6.05',
    ]);
  });
});
