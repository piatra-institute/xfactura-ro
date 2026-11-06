import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import { sourceXml, type XmlElement } from 'xfactura-core/xml';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { service, type Issued } from './fixtures/sales';
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

async function company(rateFile = bnr) {
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
      evidenceId: (await file('nbrfxrates.xml', rateFile)).id,
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
      await s.list(s.owner, 'fx.rates', {
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
    const [movement] = await s.list<{ id: string }>(s.owner, 'bank.movements', {
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
    // The receivable leaves at the rate it is carried at, March's closing 4.9900 (1,210.00 ×
    // 4.9900 = 6,037.90): each line's lei are its euro at its rate; the difference in lei only.
    expect(settled.effect!.lines.map((line) => line.currency?.rate ?? null)).toEqual([
      '5.0000',
      '4.9900',
      null,
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
    // Half of 6,037.90 is released, 605.00 at the carrying 4.9900; 605.00 × 5 = 3,025.00 is
    // received.
    expect(lines(settled)).toEqual([
      'D 5124 3025.00 [EUR 605.00]',
      'C 4111 3018.95 [EUR 605.00]',
      'C 7651 6.05',
    ]);
    expect(settled.effect!.lines[1]!.currency?.rate).toBe('4.9900');
  });
});

// Credit notes in a currency. Synthetic BNR rates; every amount below is computed by hand. A
// credit note keeps its invoice's rate for its VAT base and VAT (Codul fiscal art. 282 alin. (9),
// norme pct. 25 alin. (2)), books its revenue or expense at the rate of its own date (OMFP
// 1802/2014 pct. 319), releases the receivable or payable at its carrying amount and opens a
// refund at its own rate; the rest is an exchange difference (pct. 322).
//   EXP-1 (10 March, 4.9765): 1,000.00 + 210.00 EUR, VAT 1,045.07 lei (210.00 × 4.9765 =
//     1,045.065); the receivable 6,021.57 [1,210.00] is carried at 4.9765 (1,210.00 × 4.9765 =
//     6,021.565).
//   CN-1 (20 March, 4.9850): 100.00 + 21.00 EUR. VAT 21.00 × 4.9765 = 104.5065 → 104.51, its base
//     100.00 × 4.9765 = 497.65; revenue 100.00 × 4.9850 = 498.50; the receivable 121.00 × 4.9765
//     = 602.1565 → 602.16; 498.50 + 104.51 − 602.16 = 0.85 gained (7651).
//   CN-2 (8 April, 5.0100), after March's revaluation at 4.9900 (1,210.00 × 4.99 = 6,037.90):
//     200.00 + 42.00 EUR. VAT 42.00 × 4.9765 = 209.013 → 209.01, its base 995.30, in April's VAT
//     period; revenue 1,002.00; the receivable 242.00 × 4.9900 = 1,207.58; 1,002.00 + 209.01 −
//     1,207.58 = 3.43 gained.
//   CN-3 (20 April, 5.0000 of 15 April), EXP-1 collected in full on 15 April: 100.00 + 21.00 EUR.
//     VAT 104.51, revenue 500.00; nothing left on the receivable, so 121.00 EUR are owed to the
//     customer on 462 at 5.0000 = 605.00; 605.00 − (500.00 + 104.51) = 0.49 lost (6651). April's
//     revaluation at 5.0200: 121.00 × 5.02 = 607.42 (2.42 more owed, lost), the EUR account's
//     1,210.00 × 5.02 = 6,074.20 (24.20 gained); paid back on 12 May at 5.0300: 608.63 against
//     607.42 carried, 1.21 lost.
//   F-1 (10 March, 4.9765), a purchase: 500.00 + 105.00 EUR, VAT 522.53 (105.00 × 4.9765 =
//     522.5325), expense 2,488.25, payable 3,010.78 [605.00]. Paid on 20 March at 4.9850: 3,015.93
//     (605.00 × 4.985 = 3,015.925) against 3,010.78, 5.15 lost. CN-F1 (25 March, 4.9850): 50.00
//     + 10.50 EUR; VAT 10.50 × 4.9765 = 52.25325 → 52.25, its base 50.00 × 4.9765 = 248.825 →
//     248.83; expense 50.00 × 4.985 = 249.25; nothing left on the payable, so 60.50 EUR are owed
//     by the supplier on 461 at 4.9850 = 301.5925 → 301.59; 301.59 − (249.25 + 52.25) = 0.09
//     gained.
const creditBnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-05-12</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-03-10"><Rate currency="EUR">4.9765</Rate></Cube>
<Cube date="2026-03-20"><Rate currency="EUR">4.9850</Rate></Cube>
<Cube date="2026-03-31"><Rate currency="EUR">4.9900</Rate></Cube>
<Cube date="2026-04-08"><Rate currency="EUR">5.0100</Rate></Cube>
<Cube date="2026-04-15"><Rate currency="EUR">5.0000</Rate></Cube>
<Cube date="2026-04-30"><Rate currency="EUR">5.0200</Rate></Cube>
<Cube date="2026-05-12"><Rate currency="EUR">5.0300</Rate></Cube>
</Body></DataSet>`;

/** A document in euro stating its VAT in lei (BT-6 = RON, BT-111), as CIUS-RO asks. */
const inEuro = (xml: string, ronVat: string) =>
  xml
    .replace(
      '</cbc:DocumentCurrencyCode>',
      '</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>',
    )
    .replace(
      '<cac:LegalMonetaryTotal>',
      `<cac:TaxTotal><cbc:TaxAmount currencyID="RON">${ronVat}</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>`,
    );
const rated = (proposal: ProposalView) =>
  proposal.effect?.lines.map(
    (line) =>
      `${line.side} ${line.account} ${line.amount}${line.currency ? ` [${line.currency.code} ${line.currency.amount} @ ${line.currency.rate}]` : ''}`,
  );
const taxes = (proposal: ProposalView) =>
  proposal.effect?.taxEntries.map(
    (entry) => `${entry.code} ${entry.base}/${entry.amount}/${entry.booked} ${entry.taxPeriod}`,
  );
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

describe('credit notes in a currency', () => {
  async function books() {
    const context = await company(creditBnr);
    const { s, file } = context;
    const invoice = await s.post(await s.approve(await context.sale('1045.07')));
    const receivable = invoice.effect!.openItems[0]!.id;
    const document = async (name: string, xml: string) =>
      s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: (await file(`${name}.xml`, xml)).id,
      });
    const original = { id: invoice.subject.replace(/^document:/, '') };
    /** A credit note of EXP-1 in euro, its VAT in lei at EXP-1's rate. */
    const creditNote = async (
      number: string,
      date: string,
      amounts: { net: string; tax: string; gross: string },
      ronVat: string,
    ) => {
      const credit = await document(
        number,
        inEuro(
          invoiceXml({
            direction: 'sale',
            credit: true,
            currency: 'EUR',
            number,
            originalNumber: 'EXP-1',
            date,
            ...amounts,
          }),
          ronVat,
        ),
      );
      return s.propose('invoices.credit', {
        documentId: credit.id,
        originalDocumentId: original.id,
        account: '704',
      });
    };
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont EUR',
      iban: eurIban,
      currency: 'EUR',
      ledgerAccount: '5124',
      openedOn: '2026-01-01',
    });
    /** Imports an MT940 statement of the euro account and returns its first unsettled movement. */
    const movement = async (name: string, text: string) => {
      await s.invoke(s.owner, 'bank.import', {
        evidenceId: (await file(name, text)).id,
        financialYearId: s.year.id,
      });
      const [found] = await s.list<{ id: string }>(s.owner, 'bank.movements', {
        unsettled: true,
      });
      return found!.id;
    };
    return { ...context, receivable, document, creditNote, movement, original };
  }

  test('a partial credit note on an unpaid invoice: VAT at the invoice’s rate, revenue at its own, the receivable at its carrying amount', async () => {
    const { s, creditNote, receivable } = await books();
    const proposal = await creditNote(
      'CN-1',
      '2026-03-20',
      { net: '100.00', tax: '21.00', gross: '121.00' },
      '104.51',
    );
    expect(codes(proposal)).toEqual([]);
    expect(rated(proposal)).toEqual([
      'D 4111 -602.16 [EUR -121.00 @ 4.9765]',
      'C 704 -498.50 [EUR -100.00 @ 4.9850]',
      'C 4427 -104.51 [EUR -21.00 @ 4.9765]',
      'C 7651 0.85',
    ]);
    expect(taxes(proposal)).toEqual(['S-21 -497.65/-104.51/-104.51 2026-03']);
    expect(proposal.rules.used.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([
        'ro.fx.adjustment.vat/2016-01-01',
        'ro.fx.adjustment.books/2016-01-01',
        'ro.fx.rate_date.accounting/2024-01-01',
      ]),
    );
    await s.post(await s.approve(proposal));
    // What is left of EXP-1: 1,089.00 EUR, 6,021.57 − 602.16 = 5,419.41 lei.
    const item = (
      await s.list<{ id: string; balance: string; balanceCurrency: string }>(
        s.owner,
        'openItems.list',
        {},
      )
    ).find((open) => open.id === receivable);
    expect([item?.balance, item?.balanceCurrency]).toEqual(['5419.41', '1089.00']);
  });

  test('on a revalued receivable, in a later VAT period: the receivable leaves at the revaluation’s rate', async () => {
    const { s, creditNote } = await books();
    await s.book('fx.revalue', { date: '2026-03-31' });
    const proposal = await creditNote(
      'CN-2',
      '2026-04-08',
      { net: '200.00', tax: '42.00', gross: '242.00' },
      '209.01',
    );
    expect(codes(proposal)).toEqual([]);
    expect(rated(proposal)).toEqual([
      'D 4111 -1207.58 [EUR -242.00 @ 4.9900]',
      'C 704 -1002.00 [EUR -200.00 @ 5.0100]',
      'C 4427 -209.01 [EUR -42.00 @ 4.9765]',
      'C 7651 3.43',
    ]);
    expect(taxes(proposal)).toEqual(['S-21 -995.30/-209.01/-209.01 2026-04']);
    expect(proposal.effect?.taxEntries[0]?.taxPoint).toBe('2026-04-08');
  });

  test('a VAT in lei at another rate than the invoice’s needs an acknowledgement', async () => {
    const { creditNote } = await books();
    // 21.00 × 4.9850, the credit note's own rate, is 104.685 → 104.69.
    const proposal = await creditNote(
      'CN-4',
      '2026-03-20',
      { net: '100.00', tax: '21.00', gross: '121.00' },
      '104.69',
    );
    expect(codes(proposal)).toEqual(['VAT_FX']);
    expect(proposal.issues[0]?.message).toContain('104.51');
    expect(proposal.issues[0]?.message).toContain('art. 282 alin. (9)');
  });

  test('on a collected invoice: a refund on 462 in euro, revalued at month-end and paid back', async () => {
    const { s, creditNote, receivable, movement } = await books();
    await s.book('fx.revalue', { date: '2026-03-31' });
    await s.book('bank.settle', {
      movementId: await movement('extras-aprilie.sta', statement('1210.00')),
      allocations: [{ openItem: receivable, amount: '1210.00' }],
    });
    const proposal = await creditNote(
      'CN-3',
      '2026-04-20',
      { net: '100.00', tax: '21.00', gross: '121.00' },
      '104.51',
    );
    expect(codes(proposal)).toEqual(['CREDIT_REFUND']);
    expect(proposal.issues[0]?.message).toContain('121.00 EUR');
    expect(rated(proposal)).toEqual([
      'C 462 605.00 [EUR 121.00 @ 5.0000]',
      'C 704 -500.00 [EUR -100.00 @ 5.0000]',
      'C 4427 -104.51 [EUR -21.00 @ 4.9765]',
      'D 6651 0.49',
    ]);
    expect(proposal.effect?.openItems).toEqual([
      expect.objectContaining({ controlAccount: '462', currency: 'EUR', kind: 'payable' }),
    ]);
    const posted = await s.post(await s.approve(proposal, s.reviewer, ['CREDIT_REFUND']));
    const refund = posted.effect!.openItems[0]!.id;
    // The refund is a monetary item: April's revaluation brings it to 5.0200.
    expect(rated(await s.book('fx.revalue', { date: '2026-04-30' }))).toEqual([
      'C 462 2.42 [EUR 0.00 @ 5.0200]',
      'D 5124 24.20 [EUR 0.00 @ 5.0200]',
      'C 7651 24.20',
      'D 6651 2.42',
    ]);
    const paid = await s.book('bank.settle', {
      movementId: await movement(
        'extras-mai.sta',
        `:20:EUR052026
:25:${eurIban}
:28C:002/001
:60F:C260501EUR1210,00
:61:2605120512D121,00NTRFCN-3//EUR-OUT-01
:86:Restituire CN-3
:62F:C260531EUR1089,00`,
      ),
      allocations: [{ openItem: refund, amount: '121.00' }],
    });
    expect(rated(paid)).toEqual([
      'C 5124 608.63 [EUR 121.00 @ 5.0300]',
      'D 462 607.42 [EUR 121.00 @ 5.0200]',
      'D 6651 1.21',
    ]);
    const balance = await s.trialBalance();
    for (const account of ['462', '4111'])
      expect(balance.rows.find((row) => row.account === account)?.closing).toEqual({
        debit: '0.00',
        credit: '0.00',
      });
  });

  test('a supplier’s credit note on a purchase already paid is owed back by the supplier on 461, in euro', async () => {
    const { s, document, movement } = await books();
    const purchase = await document(
      'F-1',
      inEuro(
        invoiceXml({
          currency: 'EUR',
          number: 'F-1',
          date: '2026-03-10',
          net: '500.00',
          tax: '105.00',
          gross: '605.00',
        }),
        '522.53',
      ),
    );
    const booked = await s.book('invoices.recognize', { documentId: purchase.id, account: '628' });
    expect(rated(booked)).toEqual([
      'D 628 2488.25 [EUR 500.00 @ 4.9765]',
      'D 4426 522.53 [EUR 105.00 @ 4.9765]',
      'C 401 3010.78 [EUR 605.00 @ 4.9765]',
    ]);
    const paid = await s.book('bank.settle', {
      movementId: await movement(
        'extras-martie.sta',
        `:20:EUR032026
:25:${eurIban}
:28C:001/001
:60F:C260301EUR0,00
:61:2603200320D605,00NTRFF-1//EUR-OUT-01
:86:Plata F-1
:62F:D260331EUR605,00`,
      ),
      allocations: [{ openItem: booked.effect!.openItems[0]!.id, amount: '605.00' }],
    });
    expect(rated(paid)).toEqual([
      'C 5124 3015.93 [EUR 605.00 @ 4.9850]',
      'D 401 3010.78 [EUR 605.00 @ 4.9765]',
      'D 6651 5.15',
    ]);
    const credit = await document(
      'CN-F1',
      inEuro(
        invoiceXml({
          credit: true,
          currency: 'EUR',
          number: 'CN-F1',
          originalNumber: 'F-1',
          date: '2026-03-25',
          net: '50.00',
          tax: '10.50',
          gross: '60.50',
        }),
        '52.25',
      ),
    );
    const proposal = await s.propose('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: purchase.id,
      account: '628',
    });
    expect(codes(proposal)).toEqual(['CREDIT_REFUND']);
    expect(rated(proposal)).toEqual([
      'D 628 -249.25 [EUR -50.00 @ 4.9850]',
      'D 4426 -52.25 [EUR -10.50 @ 4.9765]',
      'D 461 301.59 [EUR 60.50 @ 4.9850]',
      'C 7651 0.09',
    ]);
    expect(taxes(proposal)).toEqual(['S-21 -248.83/-52.25/-52.25 2026-03']);
    await s.post(await s.approve(proposal, s.reviewer, ['CREDIT_REFUND']));
    const balance = await s.trialBalance();
    expect(balance.rows.find((row) => row.account === '461')?.closing).toEqual({
      debit: '301.59',
      credit: '0.00',
    });
    expect(balance.rows.find((row) => row.account === '401')?.closing).toEqual({
      debit: '0.00',
      credit: '0.00',
    });
  });

  test('a credit note in lei on an invoice in euro is refused', async () => {
    const { s, document, original } = await books();
    const credit = await document(
      'CN-RON',
      invoiceXml({
        direction: 'sale',
        credit: true,
        number: 'CN-RON',
        originalNumber: 'EXP-1',
        date: '2026-03-20',
      }),
    );
    const proposal = await s.propose('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: original.id,
      account: '704',
    });
    expect(codes(proposal)).toEqual(['CURRENCY']);
  });
});

// The returns of a company whose March and April hold the credit notes above, issued through the
// invoicer (EXP-1 is XF0001, CN-1 XF0002, CN-2 XF0003) with valid CUIs: the company 18547290,
// the customer 14399840, the supplier 26000020. ANAF's validators run when installed (`bun run
// validators:fetch`) with Java; without them those tests are skipped, never passed.
const root = path.join(import.meta.dir, '../../../..');
const generalKit = path.join(root, '.validators/anaf/dist');
const saftKit = path.join(root, '.validators/anaf-saft/duk_SAFT_an_luna/dist');
const officialReturns =
  DukIntegrator.available(generalKit) && DukIntegrator.available(saftKit) && Bun.which('java')
    ? test
    : test.skip;
type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};
const returnOptions = {
  D300: {
    declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
    caen: '6201',
    bank: 'Banca Exemplu',
    account: 'RO49AAAA1B31007593840000',
  },
  D394: {
    caen: '6201',
    phone: '0236123456',
    representative: {
      name: 'Popescu Ana',
      role: 'Administrator',
      address: 'Galați, Str. Lungă 10',
    },
    preparer: {
      kind: 'company',
      cui: '14399840',
      name: 'Contabil Exemplu SRL',
      capacity: 'Împuternicit',
    },
    consultation: true,
    affiliates: false,
  },
  D406: { contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' } },
};

describe('credit notes in a currency: the returns', () => {
  async function months(validator?: DeclarationValidator) {
    const s = await scenario({
      cui: '18547290',
      ...(validator ? { declarationValidator: validator } : {}),
    });
    open.push(s);
    const fact = async (axis: string, value: string) =>
      s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
    await fact('vat.status', 'normal_vat');
    await fact('vat.period', 'monthly');
    const file = async (filename: string, text: string) =>
      (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename,
          mediaType: 'application/xml',
          base64: Buffer.from(text).toString('base64'),
        })
      ).id;
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('bnr.xml', creditBnr) });
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Servicii SRL',
        vatId: 'RO18547290',
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    for (const [name, iban, currency, ledgerAccount] of [
      ['Cont curent', 'RO49AAAA1B31007593840000', 'RON', '5121'],
      ['Cont EUR', eurIban, 'EUR', '5124'],
    ] as const)
      await s.invoke(s.owner, 'treasury.createAccount', {
        kind: 'bank',
        name,
        iban,
        currency,
        ledgerAccount,
        openedOn: '2026-01-01',
      });
    const details = (partyId: string, name: string, cui: string) =>
      s.invoke(s.owner, 'parties.recordDetails', {
        partyId,
        details: {
          name,
          vatId: `RO${cui}`,
          address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
        },
      });
    const customer = await s.party('Client Unu SRL', '14399840');
    await details(customer.id, 'Client Unu SRL', '14399840');
    const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
      code: 'XF',
      prefix: 'XF',
      width: 4,
      revenueAccount: '704',
    });
    /** Issues an invoice or credit note in euro and posts the recognition it proposes. */
    const issue = async (input: Record<string, unknown>) => {
      const issued = await s.invoke<Issued>(s.owner, 'sales.issue', {
        seriesId: series.id,
        buyerId: customer.id,
        currency: 'EUR',
        ...input,
      });
      const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
        id: issued.recognition.proposalId,
      });
      return { issued, proposal, posted: await s.post(await s.approve(proposal)) };
    };
    const sale = await issue({
      issueDate: '2026-03-10',
      lines: [service('1000')],
      vatAccountingTotal: '1045.07',
    });
    const cn1 = await issue({
      typeCode: '381',
      issueDate: '2026-03-20',
      precedingDocumentIds: [sale.issued.documentId],
      lines: [service('100')],
      vatAccountingTotal: '104.51',
    });
    // F-1 from the supplier, paid from the euro account, then credited by CN-F1.
    const imported = async (number: string, xml: string) => {
      const document = await s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
        evidenceId: await file(`${number}.xml`, xml),
      });
      await details(document.partyId, 'Companie 26000020', '26000020');
      return document;
    };
    const purchase = await imported(
      'F-1',
      inEuro(
        invoiceXml({
          company: '18547290',
          counterparty: 'RO26000020',
          currency: 'EUR',
          number: 'F-1',
          date: '2026-03-10',
          net: '500.00',
          tax: '105.00',
          gross: '605.00',
        }),
        '522.53',
      ),
    );
    const bought = await s.book('invoices.recognize', { documentId: purchase.id, account: '628' });
    await s.invoke(s.owner, 'bank.import', {
      evidenceId: await file(
        'extras-martie.sta',
        `:20:EUR032026
:25:${eurIban}
:28C:001/001
:60F:C260301EUR0,00
:61:2603200320D605,00NTRFF-1//EUR-OUT-01
:86:Plata F-1
:62F:D260331EUR605,00`,
      ),
      financialYearId: s.year.id,
    });
    const [payment] = await s.list<{ id: string }>(s.owner, 'bank.movements', {
      unsettled: true,
    });
    await s.book('bank.settle', {
      movementId: payment!.id,
      allocations: [{ openItem: bought.effect!.openItems[0]!.id, amount: '605.00' }],
    });
    const supplierCredit = await imported(
      'CN-F1',
      inEuro(
        invoiceXml({
          company: '18547290',
          counterparty: 'RO26000020',
          credit: true,
          currency: 'EUR',
          number: 'CN-F1',
          originalNumber: 'F-1',
          date: '2026-03-25',
          net: '50.00',
          tax: '10.50',
          gross: '60.50',
        }),
        '52.25',
      ),
    );
    await s.post(
      await s.approve(
        await s.propose('invoices.credit', {
          documentId: supplierCredit.id,
          originalDocumentId: purchase.id,
          account: '628',
        }),
        s.reviewer,
        ['CREDIT_REFUND'],
      ),
    );
    await s.book('fx.revalue', { date: '2026-03-31' });
    const cn2 = await issue({
      typeCode: '381',
      issueDate: '2026-04-08',
      precedingDocumentIds: [sale.issued.documentId],
      lines: [service('200')],
      vatAccountingTotal: '209.01',
    });
    const prepare = (kind: 'D300' | 'D394' | 'D406', period: string) =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind,
        period,
        options: returnOptions[kind],
      });
    /** The XML of a prepared return, without whitespace between elements. */
    const xml = async (artifact: Artifact) =>
      new TextDecoder()
        .decode((await s.engine.evidence.read(s.owner, artifact.evidenceId)).bytes)
        .replace(/>\s+</g, '><');
    return { s, sale, cn1, cn2, prepare, xml };
  }

  test('credit notes issued in euro: VAT at the invoice’s rate, in their own months', async () => {
    const { s, sale, cn1, cn2, prepare, xml } = await months();
    expect(rated(sale.posted)).toEqual([
      'D 4111 6021.57 [EUR 1210.00 @ 4.9765]',
      'C 704 4976.50 [EUR 1000.00 @ 4.9765]',
      'C 4427 1045.07 [EUR 210.00 @ 4.9765]',
    ]);
    expect(codes(cn1.proposal)).toEqual([]);
    // The e-Factura credit note in euro: its currency, BT-6 = RON and its VAT in lei (BT-111), at
    // EXP-1's rate.
    const ubl = new TextDecoder().decode(
      (await s.engine.evidence.read(s.owner, cn1.issued.evidenceId)).bytes,
    );
    for (const part of [
      '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>',
      '<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>',
      '<cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>',
      '<cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount>',
      '<cbc:TaxAmount currencyID="RON">104.51</cbc:TaxAmount>',
      '<cbc:ID>XF0001</cbc:ID>',
    ])
      expect(ubl).toContain(part);
    expect(rated(cn1.posted)).toEqual([
      'D 4111 -602.16 [EUR -121.00 @ 4.9765]',
      'C 704 -498.50 [EUR -100.00 @ 4.9850]',
      'C 4427 -104.51 [EUR -21.00 @ 4.9765]',
      'C 7651 0.85',
    ]);
    // After March's revaluation the receivable's 1,089.00 EUR are carried at 4.9900.
    expect(rated(cn2.posted)).toEqual([
      'D 4111 -1207.58 [EUR -242.00 @ 4.9900]',
      'C 704 -1002.00 [EUR -200.00 @ 5.0100]',
      'C 4427 -209.01 [EUR -42.00 @ 4.9765]',
      'C 7651 3.43',
    ]);
    const summary = async (kind: 'D300' | 'D394', period: string) =>
      JSON.parse((await prepare(kind, period)).steps[0]!.detail!);
    // March: EXP-1's base 4,976.50 less CN-1's 497.65 = 4,478.85, VAT 1,045.07 − 104.51 = 940.56;
    // F-1's 2,488.25 less CN-F1's 248.83 = 2,239.42, VAT 522.53 − 52.25 = 470.28, all deducted.
    expect((await summary('D300', '2026-03')).rows).toEqual({
      R9_1: 4479,
      R9_2: 941,
      R22_1: 2239,
      R22_2: 470,
      R28_2: 470,
    });
    // April: CN-2 alone, at EXP-1's rate: −995.30 and −209.01.
    expect((await summary('D300', '2026-04')).rows).toEqual({ R9_1: -995, R9_2: -209 });
    expect((await summary('D394', '2026-03')).operations).toEqual([
      { type: 'L', rate: '21', partner: '14399840', invoices: 2, base: 4479, vat: 941 },
      { type: 'A', rate: '21', partner: '26000020', invoices: 2, base: 2239, vat: 470 },
    ]);
    expect((await summary('D394', '2026-04')).operations).toEqual([
      { type: 'L', rate: '21', partner: '14399840', invoices: 1, base: -995, vat: -209 },
    ]);
    // D406: CN-2's revenue line at its own rate, its VAT (TaxAmount) at EXP-1's, each amount its
    // currency at its rate (−200.00 × 5.0100 = −1,002.00; −42.00 × 4.9765 = −209.01).
    const april = await xml(await prepare('D406', '2026-04'));
    expect(april).toContain(
      '<nsSAFT:Amount>-1002.00</nsSAFT:Amount><nsSAFT:CurrencyCode>EUR</nsSAFT:CurrencyCode><nsSAFT:CurrencyAmount>-200.00</nsSAFT:CurrencyAmount><nsSAFT:ExchangeRate>5.0100</nsSAFT:ExchangeRate>',
    );
    expect(april).toContain(
      '<nsSAFT:TaxAmount><nsSAFT:Amount>-209.01</nsSAFT:Amount><nsSAFT:CurrencyCode>EUR</nsSAFT:CurrencyCode><nsSAFT:CurrencyAmount>-42.00</nsSAFT:CurrencyAmount><nsSAFT:ExchangeRate>4.9765</nsSAFT:ExchangeRate></nsSAFT:TaxAmount>',
    );
  });

  officialReturns(
    "D300, D394 and D406 with credit notes in euro pass ANAF's validators",
    async () => {
      const { prepare } = await months(
        new AnafKits({
          general: new DukIntegrator(generalKit),
          saft: new DukIntegrator(saftKit, saftKitId),
        }),
      );
      for (const kind of ['D300', 'D394', 'D406'] as const)
        for (const period of ['2026-03', '2026-04']) {
          const artifact = await prepare(kind, period);
          expect([kind, period, artifact.state, artifact.steps.at(-1)?.detail ?? null]).toEqual([
            kind,
            period,
            'validated_official',
            null,
          ]);
        }
    },
    240_000,
  );
});

// A receivable carried at no single rate: EXP-M, issued on 20 March for a supply of 10 March,
// books its revenue at the issue date's 4.9850 (1,000.00 EUR = 4,985.00 lei) and its VAT at the
// supply's 4.9765 (210.00 EUR = 1,045.07 lei): 6,030.07 lei for 1,210.00 EUR, which no rate gives
// (1,210.00 × 4.9850 = 6,031.85). Every amount below by hand:
//   31 March, before the revaluation: 605.00 EUR received at 4.9900 (3,018.95 lei); half the
//     receivable leaves in proportion, 6,030.07 × 605 / 1,210 = 3,015.035 → 3,015.04; 3.91
//     gained. In D406, at the receivable's rate: 605.00 × 4.9850 = 3,015.925 → 3,015.93, and
//     −0.89 in lei.
//   CN-M1 of 31 March, 100.00 + 21.00 EUR at 4.9900: VAT 21.00 × 4.9765 = 104.51, base 497.65,
//     revenue 499.00; the receivable leaves in proportion, (6,030.07 − 3,015.04) × 121 / 605 =
//     603.006 → 603.01; 499.00 + 104.51 − 603.01 = 0.50 gained. In D406: −121.00 × 4.9850 =
//     −603.185 → −603.19, and 0.18 in lei.
//   The revaluation of 31 March: 484.00 EUR at 4.9900 = 2,415.16 against 2,412.02 carried, 3.14
//     gained; from then on the receivable is carried at 4.9900.
//   CN-M2 of 8 April, 200.00 + 42.00 EUR at 5.0100: VAT 42.00 × 4.9765 = 209.01, base 995.30,
//     revenue 1,002.00; the receivable 242.00 × 4.9900 = 1,207.58; 3.43 gained.
describe('a receivable carried at no single rate', () => {
  async function mixed(validator?: DeclarationValidator) {
    const s = await scenario({
      cui: '18547290',
      ...(validator ? { declarationValidator: validator } : {}),
    });
    open.push(s);
    const fact = async (axis: string, value: string) =>
      s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
    await fact('vat.status', 'normal_vat');
    await fact('vat.period', 'monthly');
    const file = async (filename: string, text: string) =>
      (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename,
          mediaType: 'application/xml',
          base64: Buffer.from(text).toString('base64'),
        })
      ).id;
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('bnr.xml', creditBnr) });
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Servicii SRL',
        vatId: 'RO18547290',
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    for (const [name, iban, currency, ledgerAccount] of [
      ['Cont curent', 'RO49AAAA1B31007593840000', 'RON', '5121'],
      ['Cont EUR', eurIban, 'EUR', '5124'],
    ] as const)
      await s.invoke(s.owner, 'treasury.createAccount', {
        kind: 'bank',
        name,
        iban,
        currency,
        ledgerAccount,
        openedOn: '2026-01-01',
      });
    const customer = await s.party('Client Unu SRL', '14399840');
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: customer.id,
      details: {
        name: 'Client Unu SRL',
        vatId: 'RO14399840',
        address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
      },
    });
    const imported = async (number: string, xml: string) =>
      s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: await file(`${number}.xml`, xml),
      });
    const original = await imported(
      'EXP-M',
      inEuro(
        invoiceXml({
          company: '18547290',
          counterparty: '14399840',
          direction: 'sale',
          currency: 'EUR',
          number: 'EXP-M',
          date: '2026-03-20',
          deliveryDate: '2026-03-10',
          net: '1000.00',
          tax: '210.00',
          gross: '1210.00',
        }),
        '1045.07',
      ),
    );
    const sold = await s.book('invoices.recognize', { documentId: original.id, account: '704' });
    const receivable = sold.effect!.openItems[0]!.id;
    await s.invoke(s.owner, 'bank.import', {
      evidenceId: await file(
        'extras-martie.sta',
        `:20:EUR032026
:25:${eurIban}
:28C:001/001
:60F:C260301EUR0,00
:61:2603310331C605,00NTRFEXP-M//EUR-IN-03
:86:Incasare partiala EXP-M
:62F:C260331EUR605,00`,
      ),
      financialYearId: s.year.id,
    });
    const [movement] = await s.list<{ id: string }>(s.owner, 'bank.movements', {
      unsettled: true,
    });
    const settled = await s.book('bank.settle', {
      movementId: movement!.id,
      allocations: [{ openItem: receivable, amount: '605.00' }],
    });
    const credit = async (number: string, date: string, net: string, tax: string) => {
      const document = await imported(
        number,
        inEuro(
          invoiceXml({
            company: '18547290',
            counterparty: '14399840',
            direction: 'sale',
            credit: true,
            currency: 'EUR',
            number,
            originalNumber: 'EXP-M',
            date,
            net,
            tax,
            gross: (Number(net) + Number(tax)).toFixed(2),
          }),
          (Math.round(Number(tax) * 4.9765 * 100) / 100).toFixed(2),
        ),
      );
      return s.book('invoices.credit', {
        documentId: document.id,
        originalDocumentId: original.id,
        account: '704',
      });
    };
    const first = await credit('CN-M1', '2026-03-31', '100.00', '21.00');
    const revalued = await s.book('fx.revalue', { date: '2026-03-31' });
    const second = await credit('CN-M2', '2026-04-08', '200.00', '42.00');
    const prepare = (period: string) =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind: 'D406',
        period,
        options: returnOptions.D406,
      });
    return { s, sold, settled, first, revalued, second, prepare };
  }
  /** Each line of a D406 transaction or payment: its account, side, lei and currency side. */
  const amounts = (node: XmlElement) =>
    node.children
      .filter((child) => child.local === 'TransactionLine' || child.local === 'PaymentLine')
      .map((line) => {
        const amount = line.children.find((child) =>
          ['DebitAmount', 'CreditAmount', 'PaymentLineAmount'].includes(child.local),
        )!;
        const field = (name: string) =>
          amount.children.find((child) => child.local === name)?.text.trim();
        const account = line.children.find((child) => child.local === 'AccountID')!.text.trim();
        const side =
          amount.local === 'PaymentLineAmount'
            ? line.children.find((child) => child.local === 'DebitCreditIndicator')!.text.trim()
            : amount.local[0];
        return `${account} ${side} ${field('Amount')} ${field('CurrencyCode')} ${field('CurrencyAmount')}${field('ExchangeRate') ? ` @ ${field('ExchangeRate')}` : ''}`;
      });
  const all = (node: XmlElement, local: string): XmlElement[] =>
    node.children.flatMap((child) => (child.local === local ? [child] : all(child, local)));
  const of = async (s: Scenario, artifact: Artifact) =>
    sourceXml((await s.engine.evidence.read(s.owner, artifact.evidenceId)).bytes);
  /** The transaction whose lines cite a document. */
  const transaction = (file: XmlElement, document: string) =>
    all(file, 'Transaction').find((node) =>
      all(node, 'SourceDocumentID').some((id) => id.text.trim() === document),
    )!;

  test('its proportional releases keep their lei: D406 writes each at the receivable’s rate and the rest in lei', async () => {
    const { s, sold, settled, first, revalued, second, prepare } = await mixed();
    // The books, as the treatments release such a receivable: in proportion to its balance.
    expect(rated(sold)).toEqual([
      'D 4111 6030.07 [EUR 1210.00 @ 4.9850]',
      'C 704 4985.00 [EUR 1000.00 @ 4.9850]',
      'C 4427 1045.07 [EUR 210.00 @ 4.9765]',
    ]);
    expect(rated(settled)).toEqual([
      'D 5124 3018.95 [EUR 605.00 @ 4.9900]',
      'C 4111 3015.04 [EUR 605.00 @ 4.9900]',
      'C 7651 3.91',
    ]);
    expect(rated(first)).toEqual([
      'D 4111 -603.01 [EUR -121.00 @ 4.9900]',
      'C 704 -499.00 [EUR -100.00 @ 4.9900]',
      'C 4427 -104.51 [EUR -21.00 @ 4.9765]',
      'C 7651 0.50',
    ]);
    // The euro account's 605.00 EUR are 3,018.95 lei at 4.9900 already.
    expect(rated(revalued)).toEqual(['D 4111 3.14 [EUR 0.00 @ 4.9900]', 'C 7651 3.14']);
    expect(rated(second)).toEqual([
      'D 4111 -1207.58 [EUR -242.00 @ 4.9900]',
      'C 704 -1002.00 [EUR -200.00 @ 5.0100]',
      'C 4427 -209.01 [EUR -42.00 @ 4.9765]',
      'C 7651 3.43',
    ]);

    // March's D406: each such line at the rate the receivable was recorded at, 4.9850, and what
    // its lei leave in lei only (CurrencyAmount × ExchangeRate = Amount, S.AM.4).
    const march = await of(s, await prepare('2026-03'));
    expect(amounts(transaction(march, 'EXP-M'))).toEqual([
      '4111 D 6031.85 EUR 1210.00 @ 4.9850',
      '4111 D -1.78 RON -1.78',
      '704 C 4985.00 EUR 1000.00 @ 4.9850',
      '4427 C 1045.07 EUR 210.00 @ 4.9765',
    ]);
    expect(amounts(transaction(march, 'EUR-IN-03'))).toEqual([
      '5124 D 3018.95 EUR 605.00 @ 4.9900',
      '4111 C 3015.93 EUR 605.00 @ 4.9850',
      '4111 C -0.89 RON -0.89',
      '7651 C 3.91 RON 3.91',
    ]);
    expect(amounts(transaction(march, 'CN-M1'))).toEqual([
      '4111 D -603.19 EUR -121.00 @ 4.9850',
      '4111 D 0.18 RON 0.18',
      '704 C -499.00 EUR -100.00 @ 4.9900',
      '4427 C -104.51 EUR -21.00 @ 4.9765',
      '7651 C 0.50 RON 0.50',
    ]);
    // The payment mirrors the receivable's lines.
    expect(all(march, 'Payment').map(amounts)).toEqual([
      ['4111 D 3015.93 EUR 605.00 @ 4.9850', '4111 D -0.89 RON -0.89'],
    ]);
    // After the revaluation the receivable is carried at 4.9900: April's credit note needs no
    // split.
    const april = await of(s, await prepare('2026-04'));
    expect(amounts(transaction(april, 'CN-M2'))).toEqual([
      '4111 D -1207.58 EUR -242.00 @ 4.9900',
      '704 C -1002.00 EUR -200.00 @ 5.0100',
      '4427 C -209.01 EUR -42.00 @ 4.9765',
      '7651 C 3.43 RON 3.43',
    ]);
  });

  officialReturns(
    "its months pass ANAF's SAF-T validator",
    async () => {
      const { prepare } = await mixed(
        new AnafKits({
          general: new DukIntegrator(generalKit),
          saft: new DukIntegrator(saftKit, saftKitId),
        }),
      );
      for (const period of ['2026-03', '2026-04']) {
        const artifact = await prepare(period);
        expect([period, artifact.state, artifact.steps.at(-1)?.detail ?? null]).toEqual([
          period,
          'validated_official',
          null,
        ]);
      }
    },
    240_000,
  );
});

// Credit notes in euro that move goods (G1), FIFO, in depot D1; the company 18547290, its
// partner 14399840. Every amount by hand, at the rates of `creditBnr`:
//   P-1 of 10 March, bought: 10 bags of coffee, 500.00 + 105.00 EUR (VAT 522.53 lei at 4.9765):
//     D 371 2,488.25 / D 4426 522.53 / C 401 3,010.78, the lot 10 at 2,488.25 (248.825 each);
//   V-1 of 10 March, sold: 4 bags, 400.00 + 84.00 EUR (VAT 418.03 lei = 84.00 × 4.9765 =
//     418.026): D 4111 2,408.63 / C 707 1,990.60 / C 4427 418.03, the 4 out of the lot at
//     2,488.25 × 4 ÷ 10 = 995.30 (C 371 / D 607);
//   31 March: the receivable and the payable revalued at 4.9900;
//   CN-V1 of 8 April, the customer's bag back, 100.00 + 21.00 EUR (VAT 104.51 lei at V-1's 4.9765):
//     the receivable at its carrying 121.00 × 4.99 = 603.79, the revenue at 5.0100, 501.00, and
//     the bag in at what the sale took it out at, 995.30 ÷ 4 = 248.825 → 248.83, in lei and at no
//     rate (C 371 / D 607 in red); 501.00 + 104.51 − 603.79 = 1.72 gained (7651);
//   CN-P1 of 8 April, 2 bags back to the supplier, 100.00 + 21.00 EUR (VAT 104.51 lei at P-1's
//     4.9765): the payable at 603.79, the bags out of P-1's lot at what they entered at, 2,488.25 ×
//     2 ÷ 10 = 497.65, not 100.00 × 5.0100 = 501.00; 603.79 − 497.65 − 104.51 = 1.63 gained;
//   the register at April's end: P-1's lot 4 at 995.30 and the bag returned, 1 at 248.83, as 371
//     holds: 2,488.25 − 995.30 + 248.83 − 497.65 = 1,244.13.
describe('credit notes in a currency that move goods', () => {
  const cui = '18547290';
  const partner = '14399840';
  async function shop(validator?: DeclarationValidator) {
    const s = await scenario({
      cui,
      clock: () => Date.parse('2026-05-12T10:00:00Z'),
      ...(validator ? { declarationValidator: validator } : {}),
    });
    open.push(s);
    for (const [axis, value] of Object.entries({
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      'policy.stock.valuation': 'fifo',
      'policy.stock.inventory': 'permanent',
      'policy.stock.negative': 'refuse',
    }))
      await s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
    const file = async (filename: string, text: string) =>
      s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType: 'application/xml',
        base64: Buffer.from(text).toString('base64'),
      });
    await s.invoke(s.owner, 'fx.importBnr', {
      evidenceId: (await file('nbrfxrates.xml', creditBnr)).id,
    });
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Magazin SRL',
        vatId: `RO${cui}`,
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban: 'RO49AAAA1B31007593840000',
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const coffee = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code: 'CAF-1',
      name: 'Cafea boabe 1 kg',
      unit: 'H87',
      account: '371',
      nc8: '09012100',
      vatCategory: 'standard',
    });
    const depot = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code: 'D1',
      name: 'Depozit',
      keeper: 'Ionescu Maria',
    });
    const stock = (quantity: string) => ({
      warehouseId: depot.id,
      lines: [{ line: '1', itemId: coffee.id, quantity }],
    });
    const euro = async (
      input: { number: string; date: string; net: string; tax: string; gross: string },
      ronVat: string,
      options: { sale?: boolean; original?: string } = {},
    ) =>
      s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: (
          await file(
            `${input.number}.xml`,
            inEuro(
              invoiceXml({
                ...input,
                company: cui,
                counterparty: partner,
                currency: 'EUR',
                ...(options.sale ? { direction: 'sale' as const } : {}),
                ...(options.original ? { credit: true, originalNumber: options.original } : {}),
                lines: [{ rate: '21', net: input.net, name: 'Cafea boabe' }],
              }),
              ronVat,
            ),
          )
        ).id,
      });
    const bought = await euro(
      { number: 'P-1', date: '2026-03-10', net: '500.00', tax: '105.00', gross: '605.00' },
      '522.53',
    );
    const sold = await euro(
      { number: 'V-1', date: '2026-03-10', net: '400.00', tax: '84.00', gross: '484.00' },
      '418.03',
      { sale: true },
    );
    const purchase = await s.book('invoices.recognize', {
      documentId: bought.id,
      account: '371',
      stock: stock('10'),
    });
    const sale = await s.book('invoices.recognize', {
      documentId: sold.id,
      account: '707',
      stock: stock('4'),
    });
    await s.book('fx.revalue', { date: '2026-03-31' });
    const back = await euro(
      { number: 'CN-V1', date: '2026-04-08', net: '100.00', tax: '21.00', gross: '121.00' },
      '104.51',
      { sale: true, original: 'V-1' },
    );
    const returned = await euro(
      { number: 'CN-P1', date: '2026-04-08', net: '100.00', tax: '21.00', gross: '121.00' },
      '104.51',
      { original: 'P-1' },
    );
    const customerNote = () =>
      s.propose('invoices.credit', {
        documentId: back.id,
        originalDocumentId: sold.id,
        account: '707',
        stock: stock('1'),
      });
    const supplierNote = () =>
      s.propose('invoices.credit', {
        documentId: returned.id,
        originalDocumentId: bought.id,
        account: '371',
        stock: stock('2'),
      });
    const prepare = (period: string) =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind: 'D406',
        period,
        options: returnOptions.D406,
      });
    return { s, purchase, sale, customerNote, supplierNote, prepare };
  }
  const moved = (proposal: ProposalView) =>
    proposal.effect?.stockMoves?.map((move) => `${move.quantity} ${move.amount}`);

  test('goods back from the customer at the sale’s cost, and to the supplier at the receipt’s, in lei', async () => {
    const { s, purchase, sale, customerNote, supplierNote } = await shop();
    expect(rated(purchase)).toEqual([
      'D 371 2488.25 [EUR 500.00 @ 4.9765]',
      'D 4426 522.53 [EUR 105.00 @ 4.9765]',
      'C 401 3010.78 [EUR 605.00 @ 4.9765]',
    ]);
    expect(rated(sale)).toEqual([
      'D 4111 2408.63 [EUR 484.00 @ 4.9765]',
      'C 707 1990.60 [EUR 400.00 @ 4.9765]',
      'C 4427 418.03 [EUR 84.00 @ 4.9765]',
      'C 371 995.30',
      'D 607 995.30',
    ]);
    const customer = await customerNote();
    expect(codes(customer)).toEqual([]);
    expect(rated(customer)).toEqual([
      'D 4111 -603.79 [EUR -121.00 @ 4.9900]',
      'C 707 -501.00 [EUR -100.00 @ 5.0100]',
      'C 4427 -104.51 [EUR -21.00 @ 4.9765]',
      'C 371 -248.83',
      'D 607 -248.83',
      'C 7651 1.72',
    ]);
    expect(moved(customer)).toEqual(['1.000 248.83']);
    await s.post(await s.approve(customer));
    const supplier = await supplierNote();
    expect(codes(supplier)).toEqual([]);
    expect(rated(supplier)).toEqual([
      'D 371 -497.65',
      'D 4426 -104.51 [EUR -21.00 @ 4.9765]',
      'C 401 -603.79 [EUR -121.00 @ 4.9900]',
      'C 7651 1.63',
    ]);
    expect(moved(supplier)).toEqual(['-2.000 -497.65']);
    expect(taxes(supplier)).toEqual(['S-21 -497.65/-104.51/-104.51 2026-04']);
    await s.post(await s.approve(supplier));
    const register = await s.invoke<{
      positions: { code: string; quantity: string; value: string }[];
      accounts: { account: string; register: string; ledger: string; outside: string }[];
    }>(s.owner, 'stock.register', { layers: true });
    expect(register.accounts).toEqual([
      { account: '371', register: '1244.13', ledger: '1244.13', outside: '0.00' },
    ]);
  });

  test('the stock file of April: the customer’s return (40) and the return to the supplier (50)', async () => {
    const { s, customerNote, supplierNote, prepare } = await shop();
    await s.post(await s.approve(await customerNote()));
    await s.post(await s.approve(await supplierNote()));
    const april = await prepare('2026-04-C');
    expect(april.state).toBe('prepared');
    const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
      id: april.evidenceId,
    });
    const root = sourceXml(new Uint8Array(Buffer.from(base64, 'base64')));
    const text = (name: string) =>
      root.children
        .flatMap(function find(node: XmlElement): XmlElement[] {
          return [...(node.local === name ? [node] : []), ...node.children.flatMap(find)];
        })
        .map((node) => node.text.trim());
    expect(text('MovementType')).toEqual(['40', '50', '40', '50']);
    expect(text('BookValue')).toEqual(['248.83', '-497.65']);
    // P-1's lot and the bag returned, in the order of their lots' ids.
    expect(text('ClosingStockValue').sort()).toEqual(['248.83', '995.30']);
  });

  officialReturns(
    "April's stock file passes ANAF's SAF-T validator",
    async () => {
      const { s, customerNote, supplierNote, prepare } = await shop(
        new AnafKits({ saft: new DukIntegrator(saftKit, saftKitId) }),
      );
      await s.post(await s.approve(await customerNote()));
      await s.post(await s.approve(await supplierNote()));
      for (const period of ['2026-03-C', '2026-04-C']) {
        const artifact = await prepare(period);
        expect([period, artifact.state, artifact.steps.at(-1)?.detail ?? null]).toEqual([
          period,
          'validated_official',
          null,
        ]);
      }
    },
    240_000,
  );
});
