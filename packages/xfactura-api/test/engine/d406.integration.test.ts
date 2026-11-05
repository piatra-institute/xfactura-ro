import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { parseScaled } from 'xfactura-core/money';
import * as saftAgent from 'xfactura-core/ro/saft/agent';
import { sourceXml, type XmlElement } from 'xfactura-core/xml';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { service, type Issued } from './fixtures/sales';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
// D406 runs on ANAF's SAF-T kit only; without it or Java the official tests are skipped.
const saftDist = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const official = DukIntegrator.available(saftDist) && Bun.which('java') ? test : test.skip;
const kits = () => new AnafKits({ saft: new DukIntegrator(saftDist, saftKitId) });

// Synthetic company, partners (CUIs with valid control digits) and documents; amounts by hand:
//   EXP-1: 1,000.00 EUR × 5.0000 = 5,000.00 lei, VAT 210.00 EUR = 1,050.00 lei.
//   IE-1: 100.00 EUR × 5.0000 = 500.00 lei, VAT self-assessed at 21% = 105.00 lei.
//   XF0002: 2 h × 150 + 500 = 800.00 lei, VAT 168.00; the credit note CN-1 takes back 100 + 21.
//   The laptop (6,000.00 over 36 months) is depreciated by 166.67 in September.
const cui = '18547290';
const iban = 'RO49AAAA1B31007593840000';
const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-09-15</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-09-14"><Rate currency="EUR">5.0000</Rate></Cube>
</Body></DataSet>`;
const statement = `:20:SEPTEMBER2026
:25:${iban}
:28C:002/001
:60F:C260901RON20000,00
:61:2609150915C1210,00NTRFXF0001//BANK-IN-01
:86:Incasare XF0001
:61:2609200920D605,00NTRFF-100//BANK-PAY-01
:86:Plata F-100
:61:2609300930D5,00NCHGNONREF//BANK-FEE-01
:86:Comision bancar
:62F:C260930RON20600,00`;
const contact = { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' };

type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  format: string;
  steps: { state: string; actor: string | null; detail: string | null }[];
};

/** A VAT payer (or a company outside VAT) with its details, a bank account, an opening balance
 * and one customer. */
async function company(
  vatPeriod: 'monthly' | 'quarterly' | null,
  validator?: DeclarationValidator,
  status: 'normal_vat' | 'non_vat' = 'normal_vat',
) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  const fact = async (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await fact('vat.status', status);
  if (vatPeriod) await fact('vat.period', vatPeriod);
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
        { account: '5121', side: 'D', amount: '20000.00' },
        { account: '1012', side: 'C', amount: '20000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const details = (partyId: string, name: string, vatId: string, country = 'RO') =>
    s.invoke(s.owner, 'parties.recordDetails', {
      partyId,
      details: {
        name,
        vatId,
        address:
          country === 'RO'
            ? { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country }
            : { lines: ['Main Street 1'], city: 'Dublin', country },
      },
    });
  const customer = await s.party('Client Unu SRL', '14399840');
  await details(customer.id, 'Client Unu SRL', 'RO14399840');
  const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
    code: 'XF',
    prefix: 'XF',
    width: 4,
    revenueAccount: '704',
  });
  const sell = async (issueDate: string, lines: unknown[]) => {
    const issued = await s.invoke<Issued>(s.owner, 'sales.issue', {
      seriesId: series.id,
      buyerId: customer.id,
      issueDate,
      lines,
    });
    const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: issued.recognition.proposalId,
    });
    return { issued, posted: await s.post(await s.approve(proposal)) };
  };
  const file = async (filename: string, text: string) =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType: 'application/xml',
        base64: Buffer.from(text).toString('base64'),
      })
    ).id;
  /** Imports a document; a partner it creates gets its invoicing details. */
  const document = async (input: XmlInput, xml = invoiceXml({ company: cui, ...input })) => {
    const imported = await s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(`${input.number}.xml`, xml),
    });
    const counterparty = input.counterparty!;
    const country = input.country ?? 'RO';
    if (imported.partyId !== customer.id)
      await details(
        imported.partyId,
        `Companie ${counterparty}`,
        country === 'RO' ? `RO${counterparty}` : counterparty,
        country,
      );
    return imported;
  };
  const buy = async (input: XmlInput, account: string) => {
    const imported = await document(input);
    return {
      documentId: imported.id,
      posted: await s.book('invoices.recognize', { documentId: imported.id, account }),
    };
  };
  const prepare = (period: string, options: Record<string, unknown> = { contact }) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind: 'D406', period, options });
  return { s, customer, sell, document, buy, file, prepare, fact };
}

/** September 2026 of a monthly payer: sales (one in EUR, a credit note), purchases (one on the
 * ambiguous 623, a reverse charge from Ireland), a collection, a payment and a bank fee, a
 * customer's advance on 419, and depreciation; August left a receivable and an unpaid asset. */
async function september(validator?: DeclarationValidator) {
  const books = await company('monthly', validator);
  const { s, customer, sell, document, buy, file } = books;
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('nbrfxrates.xml', bnr) });

  const august = await sell('2026-08-20', [service('1000')]);
  const laptop = await buy(
    {
      number: 'F-LAPTOP',
      counterparty: '26000039',
      date: '2026-08-10',
      net: '6000.00',
      tax: '1260.00',
      gross: '7260.00',
    },
    '214',
  );
  await s.invoke(s.owner, 'assets.register', {
    catalogCode: '2.2.9',
    account: '214',
    depreciationAccount: '2814',
    commissionedOn: '2026-08-10',
    evidenceId: (await s.evidence('pv-punere-in-functiune.pdf')).id,
    number: 'MF-001',
    name: 'Laptop',
    value: '6000.00',
    lifeMonths: 36,
    fiscalLifeMonths: 36,
    documentId: laptop.documentId,
  });

  const { issued } = await sell('2026-09-10', [
    {
      name: 'Mentenanță',
      quantity: '2',
      unitCode: 'HUR',
      price: '150',
      vat: { category: 'S', rate: '21' },
    },
    service('500'),
  ]);
  const credit = await document({
    direction: 'sale',
    credit: true,
    number: 'CN-1',
    originalNumber: issued.number,
    counterparty: '14399840',
    date: '2026-09-25',
    net: '100.00',
    tax: '21.00',
    gross: '121.00',
  });
  await s.book('invoices.credit', {
    documentId: credit.id,
    originalDocumentId: issued.documentId,
    account: '704',
  });
  const euro = invoiceXml({
    company: cui,
    direction: 'sale',
    currency: 'EUR',
    number: 'EXP-1',
    counterparty: '26000004',
    date: '2026-09-15',
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
      '<cac:TaxTotal><cbc:TaxAmount currencyID="RON">1050.00</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>',
    );
  const exported = await document({ number: 'EXP-1', counterparty: '26000004' }, euro);
  await s.book('invoices.recognize', { documentId: exported.id, account: '704' });

  const hosting = await buy(
    {
      number: 'F-100',
      counterparty: '26000020',
      date: '2026-09-05',
      net: '500.00',
      tax: '105.00',
      gross: '605.00',
    },
    '628',
  );
  await buy(
    {
      number: 'F-101',
      counterparty: '26000020',
      date: '2026-09-06',
      net: '200.00',
      tax: '42.00',
      gross: '242.00',
    },
    '623',
  );
  const irish = await document({
    number: 'IE-1',
    country: 'IE',
    counterparty: 'IE6388047V',
    currency: 'EUR',
    category: 'AE',
    rate: '0',
    tax: '0.00',
    net: '100.00',
    gross: '100.00',
    date: '2026-09-15',
  });
  await s.book('invoices.crossBorder', {
    documentId: irish.id,
    account: '628',
    supply: 'services_general_rule',
  });

  await s.invoke(s.owner, 'bank.import', {
    evidenceId: (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: 'extras-septembrie.sta',
        mediaType: 'text/plain',
        base64: Buffer.from(statement).toString('base64'),
      })
    ).id,
    financialYearId: s.year.id,
  });
  const movements = await s.list<{ id: string; amount: string }>(s.owner, 'bank.movements', {});
  const movement = (amount: string) => movements.find((item) => item.amount === amount)!.id;
  await s.book('bank.settle', {
    movementId: movement('1210.00'),
    allocations: [{ openItem: august.posted.effect!.openItems[0]!.id, amount: '1210.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('-605.00'),
    allocations: [{ openItem: hosting.posted.effect!.openItems[0]!.id, amount: '605.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('-5.00'),
    lines: [{ account: '627', amount: '5.00' }],
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('chitanta-avans.pdf')).id,
      [
        { account: '5311', side: 'D', amount: '300.00' },
        { account: '419', side: 'C', amount: '300.00', newItem: 'avans' },
      ],
      { date: '2026-09-28', reference: 'CH-7', newItems: [{ ref: 'avans', partyId: customer.id }] },
    ),
  );
  await s.book('assets.depreciate', { month: '2026-09' });
  return books;
}

const children = (node: XmlElement, local: string): XmlElement[] =>
  node.children.flatMap((child) => (child.local === local ? [child] : children(child, local)));
const value = (node: XmlElement, local: string) =>
  node.children.find((child) => child.local === local)?.text.trim();
const bani = (text: string | undefined) => (text === undefined ? 0n : parseScaled(text, 2));
/** A balance written on its side, as a signed amount: debit positive. */
const balance = (node: XmlElement, moment: 'Opening' | 'Closing') =>
  bani(value(node, `${moment}DebitBalance`)) - bani(value(node, `${moment}CreditBalance`));
const net = (pair: { debit: string; credit: string }) => bani(pair.debit) - bani(pair.credit);

async function fileOf(s: Scenario, artifact: Artifact) {
  const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
    id: artifact.evidenceId,
  });
  return sourceXml(new Uint8Array(Buffer.from(base64, 'base64')));
}

describe('D406 from the books', () => {
  test('lists the accounts as the trial balance, the partners as their open items, and the VAT by code', async () => {
    const { s, prepare } = await september();
    const prepared = await prepare('2026-09', { contact, accounts: { '623': '6231' } });
    expect(prepared.state).toBe('prepared');
    expect(prepared.format).toBe('D406 mfp:anaf:dgti:d406:declaratie:v1');
    const file = await fileOf(s, prepared);
    expect(value(children(file, 'Header')[0]!, 'HeaderComment')).toBe('L');
    expect(children(file, 'SelectionStartDate')[0]!.text).toBe('2026-09-01');

    // Accounts: the balance at the period's start, the period's turnover and the closing balance
    // are the trial balance's.
    const trial = await s.trialBalance('2026-09-01', '2026-09-30');
    const accounts = children(file, 'Account');
    const turnover = new Map<string, { debit: bigint; credit: bigint }>();
    for (const line of children(file, 'TransactionLine')) {
      const account = value(line, 'AccountID')!;
      const total = turnover.get(account) ?? { debit: 0n, credit: 0n };
      total.debit += bani(
        children(line, 'DebitAmount')[0] && value(children(line, 'DebitAmount')[0]!, 'Amount'),
      );
      total.credit += bani(
        children(line, 'CreditAmount')[0] && value(children(line, 'CreditAmount')[0]!, 'Amount'),
      );
      turnover.set(account, total);
    }
    const rows = trial.rows.filter((row) => /^[1-7]/.test(row.account));
    expect(accounts.map((account) => value(account, 'AccountID'))).toEqual(
      rows.map((row) => row.account),
    );
    for (const row of rows) {
      const account = accounts.find((item) => value(item, 'AccountID') === row.account)!;
      const previous = (row as unknown as { previous: { debit: string; credit: string } }).previous;
      expect([row.account, balance(account, 'Opening')]).toEqual([
        row.account,
        net(row.opening) + net(previous),
      ]);
      expect([row.account, balance(account, 'Closing')]).toEqual([row.account, net(row.closing)]);
      expect([row.account, turnover.get(row.account) ?? { debit: 0n, credit: 0n }]).toEqual([
        row.account,
        { debit: bani(row.current.debit), credit: bani(row.current.credit) },
      ]);
    }
    expect(
      value(
        accounts.find((item) => value(item, 'AccountID') === '623')!,
        'StandardAccountID',
      ),
    ).toBe('6231');

    // Partners: per account, their balances are their open items' (nothing is posted after the
    // period); the customer with an advance is listed on 4111 and on 419.
    const items = await s.list<{ account: string; party: string; balance: string }>(
      s.owner,
      'openItems.list',
      { openOnly: false },
    );
    const expected = new Map<string, bigint>();
    for (const item of items) {
      if (!['4111', '419', '401', '404'].includes(item.account)) continue;
      const key = `${item.party}|${item.account}`;
      expected.set(key, (expected.get(key) ?? 0n) + bani(item.balance));
    }
    const partners = [...children(file, 'Customer'), ...children(file, 'Supplier')].map((node) => [
      `${children(node, 'Name')[0]!.text}|${value(node, 'AccountID')}`,
      balance(node, 'Closing'),
    ]);
    expect(Object.fromEntries(partners)).toEqual(Object.fromEntries(expected));
    expect(
      children(file, 'Customer').map((node) => [
        value(node, 'CustomerID'),
        value(node, 'AccountID'),
        balance(node, 'Opening'),
        balance(node, 'Closing'),
      ]),
    ).toEqual([
      ['0014399840', '4111', 121000n, 84700n],
      ['0014399840', '419', 0n, -30000n],
      ['0026000004', '4111', 0n, 605000n],
    ]);
    expect(children(file, 'Supplier').map((node) => value(node, 'SupplierID'))).toEqual([
      '0026000020',
      '0026000039',
      '01IE6388047V',
    ]);

    // VAT: on the base's line, by the engine's code mapped to ANAF's TaxCode.
    const taxed = children(file, 'TransactionLine').flatMap((line) =>
      children(line, 'TaxInformation')
        .filter((tax) => value(tax, 'TaxType') === '300')
        .map((tax) => [
          value(line, 'AccountID'),
          value(line, 'SourceDocumentID'),
          value(tax, 'TaxCode'),
          value(tax, 'TaxBase'),
          value(children(tax, 'TaxAmount')[0]!, 'Amount'),
        ]),
    );
    expect(taxed).toEqual([
      ['704', 'XF0002', '310344', '800.00', '168.00'],
      ['704', 'CN-1', '310344', '-100.00', '-21.00'],
      ['704', 'EXP-1', '310344', '5000.00', '1050.00'],
      ['628', 'F-100', '301104', '500.00', '105.00'],
      ['623', 'F-101', '301104', '200.00', '42.00'],
      ['628', 'IE-1', '300704', '500.00', '105.00'],
    ]);
    expect(
      children(children(file, 'TaxTable')[0]!, 'TaxCodeDetails').map((code) =>
        value(code, 'TaxCode'),
      ),
    ).toEqual(['300704', '301104', '310344']);

    // Invoices with their UBL lines, the credit note as 381; payments settling partners.
    const invoices = (section: string) =>
      children(children(file, section)[0]!, 'Invoice').map((invoice) => [
        value(invoice, 'InvoiceNo'),
        value(invoice, 'InvoiceType'),
        children(invoice, 'InvoiceLine').map((line) => [
          value(line, 'Quantity'),
          value(line, 'InvoiceUOM'),
          value(line, 'UnitPrice'),
          value(children(line, 'InvoiceLineAmount')[0]!, 'Amount'),
        ]),
      ]);
    expect(invoices('SalesInvoices')).toEqual([
      [
        'XF0002',
        '380',
        [
          ['2', 'HUR', '150.00', '300.00'],
          ['1', 'C62', '500.00', '500.00'],
        ],
      ],
      ['CN-1', '381', [['-1', 'HUR', '100.00', '-100.00']]],
      ['EXP-1', '380', [['1', 'HUR', '5000.00', '5000.00']]],
    ]);
    expect(invoices('PurchaseInvoices').map(([number]) => number)).toEqual([
      'F-100',
      'F-101',
      'IE-1',
    ]);
    expect(
      children(children(file, 'Payments')[0]!, 'Payment').map((payment) => [
        value(payment, 'PaymentRefNo'),
        value(children(payment, 'PaymentLine')[0]!, 'DebitCreditIndicator'),
        value(children(payment, 'PaymentLine')[0]!, 'SourceDocumentID'),
      ]),
    ).toEqual([
      ['BANK-IN-01', 'D', 'XF0001'],
      ['BANK-PAY-01', 'C', 'F-100'],
    ]);
  });

  test('asks for the contact and the standard account of an ambiguous one, and goes stale when the books change', async () => {
    const { s, prepare } = await september();
    const refused = await s.refused(prepare('2026-09', {}));
    const problems = (refused?.details as { problems: { code: string; message: string }[] })
      .problems;
    expect(problems.map((item) => item.code)).toEqual(['D406_CONTACT', 'D406_ACCOUNT_CHOICE']);
    expect(problems[1]!.message).toContain('6231, 6232');
    const prepared = await prepare('2026-09', { contact, accounts: { '623': '6231' } });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('nota.pdf')).id,
        [
          { account: '628', side: 'D', amount: '10.00' },
          { account: '5311', side: 'C', amount: '10.00' },
        ],
        { date: '2026-09-29' },
      ),
    );
    const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
      artifactId: prepared.id,
    });
    expect(
      (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toContain('STALE');
  });

  test('reports a purchase with half its VAT deducted (vehicles) under the 50% code', async () => {
    const { s, document, prepare } = await september();
    const fuel = await document({
      number: 'F-FUEL',
      counterparty: '26000039',
      date: '2026-09-14',
      net: '200.00',
      tax: '42.00',
      gross: '242.00',
      lines: [{ rate: '21', net: '200.00', name: 'Motorină' }],
    });
    // Fuel names no car: the reviewer confirms the half deducted (art. 298).
    const booking = await s.propose('invoices.recognize', {
      documentId: fuel.id,
      account: '6022',
      deduction: 'limited',
    });
    await s.post(await s.approve(booking, s.reviewer, ['VEHICLE_UNNAMED']));
    const file = await fileOf(
      s,
      await prepare('2026-09', { contact, accounts: { '623': '6231' } }),
    );
    expect(
      children(children(file, 'TaxTable')[0]!, 'TaxCodeDetails').map((code) =>
        value(code, 'TaxCode'),
      ),
    ).toContain('341104');
  });

  test('reports an invoice split over rates on each rate’s account, and refuses a rate split over accounts', async () => {
    const { s, document, prepare } = await september();
    const split = (number: string) =>
      document({
        number,
        counterparty: '26000039',
        date: '2026-09-12',
        net: '1200.00',
        tax: '232.00',
        gross: '1432.00',
        taxes: [
          { rate: '21', net: '1000.00', tax: '210.00' },
          { rate: '11', net: '200.00', tax: '22.00' },
        ],
        lines: [
          { rate: '21', net: '1000.00', name: 'Găzduire anuală' },
          { rate: '11', net: '200.00', name: 'Cafea pentru protocol' },
        ],
      });
    const recognize = async (number: string, allocations: unknown[]) => {
      const proposal = await s.propose('invoices.recognize', {
        documentId: (await split(number)).id,
        allocations,
      });
      // A part on 6022 (fuel) names no car: the reviewer confirms it (art. 298).
      await s.post(await s.approve(proposal, s.reviewer, ['REDUCED_RATE', 'VEHICLE_UNNAMED']));
    };
    await recognize('F-MIX', [
      { account: '628', vat: 'S-21', amount: '1000.00' },
      { account: '623', vat: 'S-11', amount: '200.00', deduction: 'none' },
    ]);
    const options = { contact, accounts: { '623': '6231' } };
    const file = await fileOf(s, await prepare('2026-09', options));
    const invoice = children(file, 'Invoice').find((node) => value(node, 'InvoiceNo') === 'F-MIX')!;
    expect(
      children(invoice, 'InvoiceLine').map((line) => [
        value(line, 'AccountID'),
        value(children(line, 'TaxInformation')[0]!, 'TaxCode'),
      ]),
    ).toEqual([
      ['628', '301104'],
      // The engine's account; its standard account (6231) is in the master data.
      ['623', '351105'],
    ]);

    // One rate's line booked on two accounts cannot be attributed.
    await recognize('F-MIX-2', [
      { account: '628', vat: 'S-21', amount: '600.00' },
      { account: '6022', vat: 'S-21', amount: '400.00' },
      { account: '623', vat: 'S-11', amount: '200.00' },
    ]);
    const refused = await s.refused(prepare('2026-09', options));
    expect(
      (refused?.details as { problems: { code: string }[] }).problems.map((item) => item.code),
    ).toEqual(['D406_SPLIT']);
  });

  test('identifies an individual by the CNP kept sealed, which no problem shows', async () => {
    const { s, prepare } = await september();
    const person = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Ionescu Maria',
    });
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: person.id,
      details: {
        name: 'Ionescu Maria',
        address: { lines: ['Str. Morii 2'], city: 'Brăila', subdivision: 'RO-BR', country: 'RO' },
      },
    });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('chitanta-avans-2.pdf')).id,
        [
          { account: '5311', side: 'D', amount: '200.00' },
          { account: '419', side: 'C', amount: '200.00', newItem: 'avans' },
        ],
        { date: '2026-09-27', reference: 'CH-8', newItems: [{ ref: 'avans', partyId: person.id }] },
      ),
    );
    const options = { contact, accounts: { '623': '6231' } };
    const refused = await s.refused(prepare('2026-09', options));
    expect(refused?.code).toBe('D406_PARTY_CODE');
    expect(refused?.message).toContain('Ionescu Maria');
    // A synthetic CNP with its control digit.
    const body = '285072217002';
    const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
    const control =
      weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
    const cnp = `${body}${control === 10 ? 1 : control}`;
    await s.invoke(s.owner, 'parties.recordCnp', { partyId: person.id, cnp });
    const prepared = await prepare('2026-09', options);
    expect(prepared.steps[0]!.detail).not.toContain(cnp);
    const customers = children(await fileOf(s, prepared), 'Customer').map((node) => [
      value(node, 'CustomerID'),
      value(node, 'AccountID'),
      balance(node, 'Closing'),
    ]);
    expect(customers).toContainEqual([`03${cnp}`, '419', -20000n]);
  });

  test('follows the VAT period of the company, and is not produced before 2025-07', async () => {
    const { s, prepare } = await company('monthly');
    const quarter = await s.refused(prepare('2026-Q3'));
    expect(quarter?.code).toBe('VAT_PERIOD');
    expect((await s.refused(prepare('2025-06')))?.code).toBe('FORMAT_GAP');
    const none = await company(null);
    expect((await none.s.refused(none.prepare('2026-09')))?.code).toBe('VAT_PERIOD');
    const quarterly = await company('quarterly');
    expect((await quarterly.s.refused(quarterly.prepare('2026-08')))?.code).toBe('VAT_PERIOD');
  });

  official(
    "a month with an invoice split over rates and a half-deducted one passes ANAF's SAF-T validator",
    async () => {
      const { s, document, prepare } = await september(kits());
      const mixed = await document({
        number: 'F-MIX',
        counterparty: '26000039',
        date: '2026-09-12',
        net: '1200.00',
        tax: '232.00',
        gross: '1432.00',
        taxes: [
          { rate: '21', net: '1000.00', tax: '210.00' },
          { rate: '11', net: '200.00', tax: '22.00' },
        ],
        lines: [
          { rate: '21', net: '1000.00', name: 'Găzduire anuală' },
          { rate: '11', net: '200.00', name: 'Cafea pentru protocol' },
        ],
      });
      const split = await s.propose('invoices.recognize', {
        documentId: mixed.id,
        allocations: [
          { account: '628', vat: 'S-21', amount: '1000.00' },
          { account: '623', vat: 'S-11', amount: '200.00', deduction: 'none' },
        ],
      });
      await s.post(await s.approve(split, s.reviewer, ['REDUCED_RATE']));
      const fuel = await document({
        number: 'F-FUEL',
        counterparty: '26000039',
        date: '2026-09-14',
        net: '200.00',
        tax: '42.00',
        gross: '242.00',
        lines: [{ rate: '21', net: '200.00', name: 'Motorină' }],
      });
      const booking = await s.propose('invoices.recognize', {
        documentId: fuel.id,
        account: '6022',
        deduction: 'limited',
      });
      await s.post(await s.approve(booking, s.reviewer, ['VEHICLE_UNNAMED']));
      const prepared = await prepare('2026-09', { contact, accounts: { '623': '6231' } });
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  official(
    "a customer's advance invoiced, then deducted on the final invoice, passes ANAF's SAF-T validator",
    async () => {
      const { s, document, prepare } = await september(kits());
      const sale = (input: Record<string, unknown>) =>
        document({ direction: 'sale', counterparty: '14399840', ...input });
      const advance = await sale({
        number: 'V-AV1',
        date: '2026-09-03',
        net: '3000.00',
        tax: '630.00',
        gross: '3630.00',
        lines: [{ rate: '21', net: '3000.00', name: 'Avans servicii de consultanță' }],
      });
      await s.book('invoices.recognize', {
        documentId: advance.id,
        allocations: [{ account: '419', vat: 'S-21', amount: '3000.00' }],
      });
      // September already holds another customer's advance: take this invoice's.
      const held = (
        await s.list<{ id: string; document: string | null }>(s.owner, 'openItems.list', {
          kind: 'advance.received',
        })
      ).find((item) => item.document === 'V-AV1');
      const final = await sale({
        number: 'V-FIN1',
        date: '2026-09-25',
        net: '7000.00',
        tax: '1470.00',
        gross: '8470.00',
        lines: [
          { rate: '21', net: '10000.00', name: 'Servicii de consultanță septembrie' },
          { rate: '21', net: '-3000.00', name: 'Storno avans V-AV1' },
        ],
      });
      await s.book('invoices.recognize', {
        documentId: final.id,
        allocations: [
          { account: '704', vat: 'S-21', amount: '10000.00' },
          { account: '419', vat: 'S-21', amount: '-3000.00', advance: held!.id },
        ],
      });
      const options = { contact, accounts: { '623': '6231' } };
      expect(
        (
          (await s.refused(prepare('2026-09', options)))?.details as {
            problems: { code: string }[];
          }
        ).problems.map((item) => item.code),
      ).toEqual(['D406_PRODUCT_KIND']);
      const prepared = await prepare('2026-09', { ...options, advances: 'services' });
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  official(
    "a month passes ANAF's SAF-T validator",
    async () => {
      const { s, prepare } = await september(kits());
      const prepared = await prepare('2026-09', { contact, accounts: { '623': '6231' } });
      expect([
        prepared.state,
        prepared.steps.at(-1)?.actor,
        prepared.steps.at(-1)?.detail ?? null,
      ]).toEqual(['validated_official', saftKitId, null]);
      // Read again from unchanged books, the file is current: it can be authorized.
      const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
        artifactId: prepared.id,
      });
      expect((request.preview as { findings: unknown[] }).findings).toEqual([]);
    },
    120_000,
  );

  official(
    "a quarter passes ANAF's SAF-T validator",
    async () => {
      const { s, sell, buy, prepare } = await company('quarterly', kits());
      await sell('2026-07-15', [service('400')]);
      await buy(
        {
          number: 'F-7',
          counterparty: '26000020',
          date: '2026-08-05',
          net: '100.00',
          tax: '21.00',
          gross: '121.00',
        },
        '628',
      );
      const prepared = await prepare('2026-Q3');
      const file = await fileOf(s, prepared);
      expect([
        value(children(file, 'Header')[0]!, 'HeaderComment'),
        children(file, 'SelectionStartDate')[0]!.text,
        children(file, 'SelectionEndDate')[0]!.text,
      ]).toEqual(['T', '2026-07-01', '2026-09-30']);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});

// A finance lease settled in lei at the euro's rate (as financing.integration.test.ts books it):
// a car of 20,000.00 EUR × 5.0000 from 2 March, half its VAT deducted (used privately too), the
// advance invoiced on 2 March, revalued at 5.0500 on 31 March, April's instalment at 5.0400:
// principal 300.00 EUR = 1,512.00 lei and interest 403.20 lei at 21% (402.19 VAT, split 317.52 /
// 84.67, half deducted); the principal releases 1,515.00 from 167, a 3.00 gain on 768, and the
// VAT not deducted on it (158.76) goes to 635.
const leaseRates = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-04-30</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-03-02"><Rate currency="EUR">5.0000</Rate></Cube>
<Cube date="2026-03-31"><Rate currency="EUR">5.0500</Rate></Cube>
<Cube date="2026-04-01"><Rate currency="EUR">5.0400</Rate></Cube>
</Body></DataSet>`;

async function leaseApril(validator?: DeclarationValidator) {
  const books = await company('monthly', validator);
  const { s, document, file, sell } = books;
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('bnr.xml', leaseRates) });
  await sell('2026-04-10', [service('1000')]);
  const lessor = await s.party('Leasing Exemplu IFN SA', '26000039');
  const record = (await s.evidence('pv-predare-primire.pdf')).id;
  const car = await s.invoke<{ id: string }>(s.owner, 'assets.register', {
    number: 'MF-1',
    name: 'Autoturism',
    catalogCode: '2.3.2.1.1',
    account: '2133',
    depreciationAccount: '2813',
    value: '100000.00',
    lifeMonths: 60,
    fiscalLifeMonths: 60,
    commissionedOn: '2026-03-02',
    evidenceId: record,
  });
  const lease = (
    await s.book('leases.commence', {
      date: '2026-03-02',
      lessorId: lessor.id,
      evidenceId: record,
      assetId: car.id,
      currency: 'EUR',
      value: '20000.00',
      settlement: 'lei',
      instalments: [
        { due: '2026-03-02', principal: '4000.00' },
        { due: '2026-04-01', principal: '300.00', interest: '80.00' },
        { due: '2026-05-01', principal: '301.20', interest: '78.80' },
        { due: '2029-03-01', principal: '15398.80' },
      ],
    })
  ).effect!.openItems[0]!;
  const asked = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
    kind: 'vehicle.use',
    subject: { kind: 'vehicle', id: 'GL-10-LSG' },
    params: {},
  });
  await s.invoke(s.owner, 'questions.answer', {
    questionId: asked.id,
    value: { use: 'mixed', from: '2026-01-01' },
  });
  const basis = { answers: [asked.id] };
  const leasePart = (amount: string, principal: string) => ({
    account: '167',
    vat: 'S-21',
    amount,
    lease: lease.id,
    principal,
    deduction: 'limited',
    vehicle: 'GL-10-LSG',
    vatExpense: '635',
  });
  const recognize = async (documentId: string, allocations: unknown[]) => {
    const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: { documentId, allocations },
      basis,
    });
    await s.post(await s.approve(proposal));
    return proposal;
  };
  const advance = await document({
    number: 'LS-AVANS',
    counterparty: '26000039',
    date: '2026-03-02',
    net: '20000.00',
    tax: '4200.00',
    gross: '24200.00',
    lines: [{ rate: '21', net: '20000.00', name: 'Avans leasing' }],
  });
  await recognize(advance.id, [leasePart('20000.00', '4000.00')]);
  await s.book('fx.revalue', { date: '2026-03-31' });
  await s.book('assets.depreciate', { month: '2026-04' });
  const instalment = await document({
    number: 'LS-0001',
    counterparty: '26000039',
    date: '2026-04-01',
    net: '1915.20',
    tax: '402.19',
    gross: '2317.39',
    lines: [
      { rate: '21', net: '1512.00', name: 'Rata de capital' },
      { rate: '21', net: '403.20', name: 'Dobânda' },
    ],
  });
  const split = await recognize(instalment.id, [
    leasePart('1512.00', '300.00'),
    { account: '666', vat: 'S-21', amount: '403.20', deduction: 'limited', vehicle: 'GL-10-LSG' },
  ]);
  return { ...books, split, options: { contact, accounts: { '635': '635' } } };
}

/** The year 2026's register: a laptop bought in March (6,000.00 over 36 months, depreciated
 * from April) and a machine bought in January (12,000.00 over 48 months, 250.00 a month from
 * February) scrapped on 15 June, its June depreciated by the company's policy. */
async function assetsYear(validator?: DeclarationValidator) {
  const books = await company('monthly', validator);
  const { s, buy, sell } = books;
  await s.invoke(s.owner, 'profile.record', {
    axis: 'entity.form',
    value: 'srl',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat-onrc.pdf')).id,
  });
  await s.invoke(s.owner, 'profile.record', {
    axis: 'policy.assets.disposal_month',
    value: 'included',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('politici-contabile.pdf')).id,
  });
  const register = async (
    number: string,
    name: string,
    account: string,
    depreciationAccount: string,
    value: string,
    lifeMonths: number,
    commissionedOn: string,
    documentId: string,
  ) =>
    s.invoke<{ id: string }>(s.owner, 'assets.register', {
      number,
      name,
      catalogCode: '2.2.9',
      account,
      depreciationAccount,
      value,
      lifeMonths,
      fiscalLifeMonths: lifeMonths,
      commissionedOn,
      documentId,
      evidenceId: (await s.evidence(`pv-${number}.pdf`)).id,
    });
  const machine = await buy(
    {
      number: 'F-UTILAJ',
      counterparty: '26000020',
      date: '2026-01-20',
      net: '12000.00',
      tax: '2520.00',
      gross: '14520.00',
    },
    '2131',
  );
  const scrapped = await register(
    'MF-002',
    'Utilaj',
    '2131',
    '2813',
    '12000.00',
    48,
    '2026-01-20',
    machine.documentId,
  );
  const laptop = await buy(
    {
      number: 'F-LAPTOP',
      counterparty: '26000039',
      date: '2026-03-05',
      net: '6000.00',
      tax: '1260.00',
      gross: '7260.00',
    },
    '214',
  );
  await register('MF-001', 'Laptop', '214', '2814', '6000.00', 36, '2026-03-05', laptop.documentId);
  await sell('2026-03-10', [service('1000')]);
  await s.invoke(s.owner, 'assets.dispose', {
    assetId: scrapped.id,
    date: '2026-06-15',
    evidenceId: (await s.evidence('pv-casare.pdf')).id,
  });
  for (let month = 2; month <= 12; month++)
    await s.book('assets.depreciate', { month: `2026-${String(month).padStart(2, '0')}` });
  await s.book('assets.derecognize', { assetId: scrapped.id });
  return books;
}

describe('D406 for a finance lease and the annual assets file', () => {
  test("reports a lease's instalment: one rate on 167 and 666, the exchange difference and the VAT not deducted without VAT", async () => {
    const { s, prepare, options } = await leaseApril();
    const file = await fileOf(s, await prepare('2026-04', options));
    const transaction = children(file, 'Transaction').find((node) =>
      children(node, 'TransactionLine').some(
        (line) => value(line, 'SourceDocumentID') === 'LS-0001',
      ),
    )!;
    expect(
      children(transaction, 'TransactionLine').map((line) => {
        const amount = children(line, 'DebitAmount')[0] ?? children(line, 'CreditAmount')[0]!;
        const tax = children(line, 'TaxInformation')[0]!;
        return [
          value(line, 'AccountID'),
          value(amount, 'Amount'),
          value(amount, 'CurrencyCode'),
          value(tax, 'TaxCode'),
          value(tax, 'TaxBase') ?? null,
          value(children(tax, 'TaxAmount')[0]!, 'Amount'),
        ];
      }),
    ).toEqual([
      // The principal leaves 167 at its carrying amount: in lei.
      ['167', '1515.00', 'RON', '341104', '1512.00', '317.52'],
      ['635', '158.76', 'RON', '000000', null, '0.00'],
      ['768', '3.00', 'RON', '000000', null, '0.00'],
      ['666', '445.53', 'RON', '341104', '403.20', '84.67'],
      ['4426', '201.10', 'RON', '000000', null, '0.00'],
      ['404', '2317.39', 'RON', '000000', null, '0.00'],
    ]);
    const invoice = children(file, 'Invoice').find(
      (node) => value(node, 'InvoiceNo') === 'LS-0001',
    )!;
    expect(
      children(invoice, 'InvoiceLine').map((line) => [
        value(line, 'AccountID'),
        value(line, 'GoodsServicesID'),
        value(children(line, 'InvoiceLineAmount')[0]!, 'Amount'),
        value(children(children(line, 'TaxInformation')[0]!, 'TaxAmount')[0]!, 'Amount'),
      ]),
    ).toEqual([
      ['167', '02', '1512.00', '317.52'],
      ['666', '02', '403.20', '84.67'],
    ]);
    const totals = children(invoice, 'InvoiceDocumentTotals')[0]!;
    expect([value(totals, 'NetTotal'), value(totals, 'GrossTotal')]).toEqual([
      '1915.20',
      '2317.39',
    ]);
  });

  official(
    "a month with a lease's instalment passes ANAF's SAF-T validator",
    async () => {
      const { prepare, options } = await leaseApril(kits());
      const prepared = await prepare('2026-04', options);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  test('writes the year’s register as the annual assets file, asks how a disposal left, and waits on the periodic files', async () => {
    const { s, prepare } = await assetsYear();
    const refused = await s.refused(prepare('2026', { contact }));
    expect(
      (refused?.details as { problems: { code: string }[] }).problems.map((item) => item.code),
    ).toEqual(['D406A_DISPOSAL_KIND']);
    const prepared = await prepare('2026', { contact, disposals: { 'MF-002': { kind: 'scrap' } } });
    expect([prepared.state, prepared.format]).toEqual([
      'prepared',
      'D406 A mfp:anaf:dgti:d406:declaratie:v1',
    ]);
    const file = await fileOf(s, prepared);
    expect([
      value(children(file, 'Header')[0]!, 'HeaderComment'),
      children(file, 'SelectionStartDate')[0]!.text,
      children(file, 'SelectionEndDate')[0]!.text,
    ]).toEqual(['A', '2026-01-01', '2026-12-31']);
    // The accounts of the assets, with the year's balances.
    expect(
      children(file, 'Account').map((account) => [
        value(account, 'AccountID'),
        balance(account, 'Opening'),
        balance(account, 'Closing'),
      ]),
    ).toEqual([
      ['2131', 0n, 0n],
      ['214', 0n, 600000n],
      ['2813', 0n, 0n],
      ['2814', 0n, -150000n],
    ]);
    const asset = (id: string) =>
      children(file, 'Asset').find((node) => value(node, 'AssetID') === id)!;
    const valuation = (id: string, field: string) =>
      value(children(asset(id), 'Valuation')[0]!, field);
    expect(
      [
        'AcquisitionAndProductionCostsBegin',
        'AcquisitionAndProductionCostsEnd',
        'AssetAddition',
        'AssetDisposal',
        'DepreciationForPeriod',
        'AccumulatedDepreciation',
        'BookValueEnd',
        'DepreciationPercentage',
      ].map((field) => [valuation('MF-001', field), valuation('MF-002', field)]),
    ).toEqual([
      ['0.00', '0.00'],
      ['6000.00', '0.00'],
      ['6000.00', '12000.00'],
      ['0.00', '-12000.00'],
      ['-1500.00', '-1250.00'],
      ['-1500.00', '0.00'],
      ['4500.00', '0.00'],
      ['33.33', '25.00'],
    ]);
    expect(value(children(asset('MF-001'), 'AssetSupplier')[0]!, 'SupplierID')).toBe('0026000039');
    // A purchase each, a depreciation per month booked, the scrapping at its net value.
    const movements = children(file, 'AssetTransaction').map((node) => [
      value(node, 'AssetID'),
      value(node, 'AssetTransactionType'),
      value(children(node, 'AssetTransactionValuation')[0]!, 'BookValueOnTransaction'),
    ]);
    expect(value(children(file, 'AssetTransactions')[0]!, 'NumberOfAssetTransactions')).toBe('17');
    expect(movements.filter(([, type]) => type !== '30')).toEqual([
      ['MF-002', '10', '12000.00'],
      ['MF-001', '10', '6000.00'],
      ['MF-002', '50', '-10750.00'],
    ]);
    expect(movements.filter(([id, type]) => id === 'MF-002' && type === '30')).toHaveLength(5);

    // ANAF takes the annual file after the year's periodic ones: March's, prepared, waits.
    await prepare('2026-03', { contact });
    const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
      artifactId: prepared.id,
    });
    expect(
      (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toContain('D406A_PERIODIC');
  });

  test('lists the annual assets file in the calendar by the statements’ deadline', async () => {
    const { s } = await assetsYear();
    const rows = await s.list<{
      kind: string;
      period: string;
      deadline: string;
      due: string | null;
      basis: { rule: string };
    }>(s.owner, 'obligations.calendar', { from: '2026-12', to: '2026-12', today: '2026-12-15' });
    expect(rows.find((row) => row.kind === 'D406' && row.period === '2026')).toMatchObject({
      deadline: 'D406.assets',
      // 150 days after 31 December 2026 is Sunday 30 May 2027.
      due: '2027-05-31',
      basis: { rule: 'obligation.d406.assets@2026' },
    });
    // Agent-ready: the worklist raises the calendar's returns (obligation.due), and the rules
    // they enforce are the rows' deadlines.
    expect(saftAgent.detectors.map((item) => item.kind)).toEqual(['obligation.due']);
    for (const row of rows.filter((item) => item.kind === 'D406'))
      expect(saftAgent.detectors[0]!.rules).toContain(`ro.deadline.${row.deadline}`);
    expect(saftAgent.questions.map((item) => item.kind)).toEqual(['profile.fact']);
    expect(saftAgent.documentTypes.map((item) => item.id)).toEqual([
      'anaf.category',
      'asset.disposal',
    ]);
    expect(saftAgent.templates).toEqual([]);
  });

  official(
    "the annual assets file passes ANAF's SAF-T validator",
    async () => {
      const { prepare } = await assetsYear(kits());
      const prepared = await prepare('2026', {
        contact,
        disposals: { 'MF-002': { kind: 'scrap' } },
      });
      expect([
        prepared.state,
        prepared.steps.at(-1)?.actor,
        prepared.steps.at(-1)?.detail ?? null,
      ]).toEqual(['validated_official', saftKitId, null]);
    },
    120_000,
  );
});

/** A synthetic CNP with a valid control digit. */
function cnpOf(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

/** October 2026 of a monthly payer with one employee on the minimum wage (4,325.00 gross: CAS
 * 1,031.00, CASS 413.00, tax 182.00, CAM 93.00, as payroll.integration.test.ts computes them),
 * one sale and one purchase. */
async function payrollOctober(validator?: DeclarationValidator) {
  const books = await company('monthly', validator);
  const { s, sell, buy } = books;
  await s.invoke(s.owner, 'profile.record', {
    axis: 'employer',
    value: 'yes',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('employer.pdf')).id,
  });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const employee = await s.invoke<{ id: string }>(s.owner, 'payroll.employees.record', {
    lastName: 'Popescu',
    firstName: 'Ana',
    cnp: cnpOf('290050112345'),
    healthFund: 'RO-GL',
  });
  await s.invoke(s.owner, 'payroll.contracts.record', {
    employeeId: employee.id,
    number: 'CIM-1',
    startDate: '2026-01-05',
    effectiveFrom: '2026-01-05',
    dailyHours: 8,
    mainJob: true,
    occupation: '251201',
    baseSalary: '4325',
  });
  const run = await s.invoke<{ id: string }>(s.owner, 'payroll.runs.prepare', {
    month: '2026-10',
    workingDays: 22,
  });
  await s.book('payroll.recognize', {
    runId: run.id,
    month: '2026-10',
    round: 1,
    authorityId: anaf.id,
  });
  await sell('2026-10-10', [service('1000')]);
  await buy(
    {
      number: 'F-200',
      counterparty: '26000020',
      date: '2026-10-05',
      net: '500.00',
      tax: '105.00',
      gross: '605.00',
    },
    '628',
  );
  return books;
}

describe('D406 taxes other than VAT', () => {
  test("payroll's lines carry the generic TaxType 000, as ANAF recommends for taxes other than VAT and WHT", async () => {
    const { s, prepare } = await payrollOctober();
    const file = await fileOf(
      s,
      await prepare('2026-10', { contact, accounts: { '646': '6461' } }),
    );
    const salaries = children(file, 'Journal').find(
      (node) => value(node, 'JournalID') === 'SALARII',
    )!;
    const taxes = children(salaries, 'TransactionLine').map((line) => {
      const tax = children(line, 'TaxInformation')[0]!;
      return [
        value(line, 'AccountID'),
        value(tax, 'TaxType'),
        value(tax, 'TaxCode'),
        value(children(tax, 'TaxAmount')[0]!, 'Amount'),
      ];
    });
    expect(taxes.map(([account]) => account)).toEqual([
      '641',
      '421',
      '421',
      '4315',
      '4316',
      '444',
      '646',
      '436',
    ]);
    expect(new Set(taxes.map(([, type, code, amount]) => `${type} ${code} ${amount}`))).toEqual(
      new Set(['000 000000 0.00']),
    );
  });

  official(
    "a month with payroll passes ANAF's SAF-T validator",
    async () => {
      const { prepare } = await payrollOctober(kits());
      const prepared = await prepare('2026-10', { contact, accounts: { '646': '6461' } });
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  /** September with a dividend paid to an individual and to a company, and rent paid to an
   * individual, each with its tax withheld at source. */
  async function withheld(validator?: DeclarationValidator) {
    const books = await september(validator);
    const { s } = books;
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('rezultat-reportat.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '50000.00' },
          { account: '1171', side: 'C', amount: '50000.00' },
        ],
        { date: '2026-01-02' },
      ),
    );
    const create = (kind: string, name: string, taxId?: string) =>
      s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind,
        country: 'RO',
        name,
        ...(taxId ? { taxId } : {}),
      });
    const anaf = await create('ro_public_institution', 'ANAF');
    const person = await create('ro_individual', 'Popescu Ana');
    const holding = await create('ro_legal_entity', 'Holding Exemplu SRL', '31552803');
    const distributed = await s.book('dividends.distribute', {
      date: '2026-09-20',
      evidenceId: (await s.evidence('hotarare-aga.pdf')).id,
      shareholders: [
        { partyId: person.id, amount: '10000.00' },
        { partyId: holding.id, amount: '5000.00' },
      ],
    });
    const [personal, corporate] = distributed.effect!.openItems;
    for (const [item, gross, acks] of [
      [personal!.id, '10000.00', []],
      [corporate!.id, '5000.00', ['DIVIDEND_EXEMPTION']],
    ] as const)
      await s.post(
        await s.approve(
          await s.propose('dividends.withhold', {
            distributionEntryId: distributed.entry!.id,
            openItem: item,
            date: '2026-09-25',
            gross,
            authorityId: anaf.id,
          }),
          s.reviewer,
          [...acks],
        ),
      );
    const rent = await s.book('payees.recognize', {
      kind: 'rent',
      partyId: person.id,
      evidenceId: (await s.evidence('contract-inchiriere.pdf')).id,
      date: '2026-09-01',
      period: '2026-09',
      amount: '2500.00',
      account: '612',
    });
    await s.book('payees.withhold', {
      openItem: rent.effect!.openItems[0]!.id,
      date: '2026-09-05',
      gross: '2500.00',
      authorityId: anaf.id,
    });
    return books;
  }
  const options = { contact, accounts: { '623': '6231', '612': '6123' } };

  test("reports tax withheld at source with ANAF's WHT codes on the line it is withheld from, and lists them in the TaxTable", async () => {
    const { s, prepare } = await withheld();
    const prepared = await prepare('2026-09', options);
    const file = await fileOf(s, prepared);
    const taxes = children(file, 'TransactionLine').flatMap((line) =>
      children(line, 'TaxInformation')
        .filter((tax) => !['000', '300'].includes(value(tax, 'TaxType')!))
        .map((tax) => [
          value(line, 'AccountID'),
          value(tax, 'TaxType'),
          value(tax, 'TaxCode'),
          value(tax, 'TaxPercentage'),
          value(tax, 'TaxBase'),
          value(children(tax, 'TaxAmount')[0]!, 'Amount'),
        ]),
    );
    // Rent: 10% of the gross less 20%; dividends: 16% of the gross, 604040 for the individual.
    expect(taxes).toEqual([
      ['462', '628', '628010', '10', '2000.00', '200.00'],
      ['457', '604', '604040', '16', '10000.00', '1600.00'],
      ['457', '150', '150080', '16', '5000.00', '800.00'],
    ]);
    const table = children(file, 'TaxTableEntry').map((entry) => [
      value(entry, 'TaxType'),
      ...children(entry, 'TaxCodeDetails').map(
        (detail) => `${value(detail, 'TaxCode')} ${value(detail, 'BaseRate')}`,
      ),
    ]);
    expect(table.slice(1)).toEqual([
      ['150', '150080 1'],
      ['604', '604040 1'],
      ['628', '628010 1'],
    ]);
  });

  official(
    "a month with dividends and rent withheld at source passes ANAF's SAF-T validator",
    async () => {
      const { prepare } = await withheld(kits());
      const prepared = await prepare('2026-09', options);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});

/** Each line's account with its VAT (TaxType 300): the TaxCode, base and VAT. */
const taxCodes = (lines: XmlElement[]) =>
  lines.map((line) => [
    value(line, 'AccountID'),
    ...children(line, 'TaxInformation')
      .filter((tax) => value(tax, 'TaxType') === '300')
      .map(
        (tax) =>
          `${value(tax, 'TaxCode')} ${value(tax, 'TaxBase')} ${value(children(tax, 'TaxAmount')[0]!, 'Amount')}`,
      ),
  ]);
const transactionLines = (file: XmlElement, document: string) =>
  children(
    children(file, 'Transaction').find((transaction) =>
      children(transaction, 'TransactionLine').some(
        (line) => value(line, 'SourceDocumentID') === document,
      ),
    )!,
    'TransactionLine',
  );

describe('D406 outside VAT, abroad and over several accounts', () => {
  /** A company outside VAT (art. 310) in the third quarter: a sale without VAT, a purchase with
   * VAT it cannot deduct, and Irish services whose VAT it owes through D301 (art. 307 alin. (2)),
   * expensed beside the base. */
  async function outside(validator?: DeclarationValidator) {
    const books = await company(null, validator, 'non_vat');
    const { s, document, file, fact } = books;
    await fact('vat.eu', 'none');
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('nbrfxrates.xml', bnr) });
    const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      taxId: '8000000000',
      name: 'ANAF',
    });
    // V-1: 1,000.00 lei without VAT (category O).
    const sale = await document({
      number: 'V-1',
      direction: 'sale',
      counterparty: '14399840',
      date: '2026-07-10',
      category: 'O',
      rate: '0',
      tax: '0.00',
      net: '1000.00',
      gross: '1000.00',
    });
    await s.book('invoices.recognize', { documentId: sale.id, account: '704' });
    // F-1: 500.00 + 105.00 lei of VAT, which stays in the expense.
    const bought = await document({
      number: 'F-1',
      counterparty: '26000020',
      date: '2026-08-05',
      net: '500.00',
      tax: '105.00',
      gross: '605.00',
    });
    await s.book('invoices.recognize', {
      documentId: bought.id,
      account: '628',
      deduction: 'none',
    });
    // ADS-1: 100.00 € at 5.0000 = 500.00 lei; 21% VAT owed, 105.00 lei on 4423.
    const ads = await document({
      number: 'ADS-1',
      country: 'IE',
      counterparty: 'IE6388047V',
      currency: 'EUR',
      category: 'AE',
      rate: '0',
      tax: '0.00',
      net: '100.00',
      gross: '100.00',
      date: '2026-09-15',
    });
    const proposal = await s.propose('invoices.crossBorder', {
      documentId: ads.id,
      account: '623',
      supply: 'services_general_rule',
      deduction: 'none',
      authorityId: anaf.id,
    });
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    await s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
    return books;
  }
  const outsideOptions = { contact, accounts: { '623': '6231' } };

  test('a company outside VAT files each quarter, as 100020, its sales under the special scheme’s code', async () => {
    const { s, prepare } = await outside();
    // Quarterly outside VAT (OPANAF nr. 1.783/2021 anexa nr. 4 pct. 3), not by month.
    const month = await s.refused(prepare('2026-08', outsideOptions));
    expect(month?.code).toBe('VAT_PERIOD');
    const file = await fileOf(s, await prepare('2026-Q3', outsideOptions));
    expect(value(children(file, 'Header')[0]!, 'HeaderComment')).toBe('T');
    expect(value(children(file, 'TaxRegistration')[0]!, 'TaxType')).toBe('100020');
    // The sale: 310326 on its revenue and its invoice line; the purchase: 351104, its VAT not
    // deducted; the Irish services: 356319 on the expense, the VAT expensed and 4423 without.
    expect(taxCodes(transactionLines(file, 'V-1'))).toEqual([
      ['4111'],
      ['704', '310326 1000.00 0.00'],
    ]);
    expect(taxCodes(transactionLines(file, 'F-1'))).toEqual([
      ['628', '351104 500.00 105.00'],
      ['401'],
    ]);
    expect(taxCodes(transactionLines(file, 'ADS-1'))).toEqual([
      ['623', '356319 500.00 105.00'],
      ['401'],
      ['623'],
      ['4423'],
    ]);
    const sale = children(file, 'Invoice').find((node) => value(node, 'InvoiceNo') === 'V-1')!;
    expect(
      children(sale, 'InvoiceLine').map((line) =>
        value(children(line, 'TaxInformation')[0]!, 'TaxCode'),
      ),
    ).toEqual(['310326']);
  });

  official(
    "a quarter outside VAT passes ANAF's SAF-T validator",
    async () => {
      const { prepare } = await outside(kits());
      const prepared = await prepare('2026-Q3', outsideOptions);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  /** A payer's sale to a French consumer below the threshold (art. 278^1): Romanian VAT. */
  async function consumerSale(validator?: DeclarationValidator) {
    const books = await company('monthly', validator);
    const { s, file, fact } = books;
    await fact('vat.distance', 'origin');
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('nbrfxrates.xml', bnr) });
    const imported = await s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(
        'EB-1.xml',
        invoiceXml({
          company: cui,
          number: 'EB-1',
          direction: 'sale',
          counterparty: '0000000000000',
          country: 'FR',
          date: '2026-09-15',
          net: '1000.00',
          tax: '210.00',
          gross: '1210.00',
        }),
      ),
    });
    // The consumer's billing address, without a VAT code.
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: imported.partyId,
      details: {
        name: 'Jeanne Martin',
        legalId: '0000000000000',
        address: { lines: ['12 rue de la Paix'], city: 'Paris', country: 'FR' },
      },
    });
    const proposal = await s.propose('invoices.euConsumer', {
      documentId: imported.id,
      account: '704',
      supply: 'electronic',
      location: [
        { kind: 'billing_address', country: 'FR' },
        { kind: 'ip', country: 'FR' },
      ],
    });
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    await s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
    return { ...books, consumer: imported.partyId };
  }

  test('a consumer of another Member State is its own customer, 04 with a code of the books, its sale under 310346', async () => {
    const { s, prepare, consumer } = await consumerSale();
    const file = await fileOf(s, await prepare('2026-09'));
    const code = `04${consumer.replace(/-/g, '').slice(0, 24).toUpperCase()}`;
    const customer = children(file, 'Customer').find((node) => value(node, 'CustomerID') === code);
    expect(customer).toBeDefined();
    const invoice = children(file, 'Invoice').find((node) => value(node, 'InvoiceNo') === 'EB-1')!;
    expect(value(children(invoice, 'CustomerInfo')[0]!, 'CustomerID')).toBe(code);
    expect(
      children(invoice, 'InvoiceLine').map((line) =>
        value(children(line, 'TaxInformation')[0]!, 'TaxCode'),
      ),
    ).toEqual(['310346']);
  });

  official(
    "a month with a sale to a consumer of another Member State passes ANAF's SAF-T validator",
    async () => {
      const { prepare } = await consumerSale(kits());
      const prepared = await prepare('2026-09');
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  test('attributes a rate’s lines over several accounts by the goods received, else by their amounts, and refuses only the lines nothing tells apart', async () => {
    const { s, document, prepare, fact } = await company('monthly');
    for (const [axis, value_] of [
      ['policy.stock.valuation', 'fifo'],
      ['policy.stock.inventory', 'permanent'],
      ['policy.stock.negative', 'refuse'],
    ] as const)
      await fact(axis, value_);
    const depot = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code: 'D1',
      name: 'Depozit',
      keeper: 'Ionescu Maria',
    });
    const item = (code: string, name: string, account: string) =>
      s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
        code,
        name,
        unit: 'H87',
        account,
      });
    const board = await item('PAL-1', 'Placă PAL', '301');
    const lacquer = await item('LAC-1', 'Lac', '3021');
    const twoLines = (number: string, first: string, second: string, names: [string, string]) => {
      const net = (Number(first) + Number(second)).toFixed(2);
      const tax = ((Number(net) * 21) / 100).toFixed(2);
      return document({
        number,
        counterparty: '26000039',
        date: '2026-09-12',
        net,
        tax,
        gross: (Number(net) + Number(tax)).toFixed(2),
        lines: [
          { rate: '21', net: first, name: names[0] },
          { rate: '21', net: second, name: names[1] },
        ],
      });
    };
    // Two materials at one rate, 250.00 each, on 301 and 3021: the reception tells them apart.
    const materials = await twoLines('M-1', '250.00', '250.00', ['Placă PAL', 'Lac']);
    await s.book('invoices.recognize', {
      documentId: materials.id,
      allocations: [
        { account: '301', vat: 'S-21', amount: '250.00' },
        { account: '3021', vat: 'S-21', amount: '250.00' },
      ],
      stock: {
        warehouseId: depot.id,
        lines: [
          { line: '1', itemId: board.id, quantity: '5' },
          { line: '2', itemId: lacquer.id, quantity: '10' },
        ],
      },
    });
    // Two services at one rate, 300.00 and 200.00, on 628 and 6028: their amounts tell them.
    const services = await twoLines('S-1', '300.00', '200.00', ['Găzduire', 'Piese mărunte']);
    await s.book('invoices.recognize', {
      documentId: services.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '300.00' },
        { account: '6028', vat: 'S-21', amount: '200.00' },
      ],
    });
    const file = await fileOf(s, await prepare('2026-09'));
    const accounts = (number: string) =>
      children(
        children(file, 'Invoice').find((node) => value(node, 'InvoiceNo') === number)!,
        'InvoiceLine',
      ).map((line) => value(line, 'AccountID'));
    expect(accounts('M-1')).toEqual(['301', '3021']);
    expect(accounts('S-1')).toEqual(['628', '6028']);
    // 250.00 and 250.00 on 628 and 6028: nothing tells which line is which.
    const same = await twoLines('S-2', '250.00', '250.00', ['Găzduire', 'Piese mărunte']);
    await s.book('invoices.recognize', {
      documentId: same.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '250.00' },
        { account: '6028', vat: 'S-21', amount: '250.00' },
      ],
    });
    const refused = await s.refused(prepare('2026-09'));
    expect(
      (refused?.details as { problems: { code: string }[] }).problems.map((item) => item.code),
    ).toEqual(['D406_SPLIT']);
  });
});
