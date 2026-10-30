import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { parseScaled } from 'xfactura-core/money';
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

/** A VAT payer with its details, a bank account, an opening balance and one customer. */
async function company(
  vatPeriod: 'monthly' | 'quarterly' | null,
  validator?: DeclarationValidator,
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
  await fact('vat.status', 'normal_vat');
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
  return { s, customer, sell, document, buy, file, prepare };
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
  const movements = await s.invoke<{ id: string; amount: string }[]>(s.owner, 'bank.movements', {});
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
    const items = await s.invoke<{ account: string; party: string; balance: string }[]>(
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

  test('refuses an invoice split over accounts or rates rather than misattribute its lines', async () => {
    const { s, document, prepare } = await september();
    const split = await document({
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
    });
    const proposal = await s.propose('invoices.recognize', {
      documentId: split.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '1000.00' },
        { account: '6022', vat: 'S-11', amount: '200.00' },
      ],
    });
    await s.post(await s.approve(proposal, s.reviewer, ['REDUCED_RATE']));
    const refused = await s.refused(prepare('2026-09', { contact, accounts: { '623': '6231' } }));
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
