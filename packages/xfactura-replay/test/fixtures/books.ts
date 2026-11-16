import {
  readD406,
  type D406FiledAccount,
  type D406FiledTransaction,
} from 'xfactura-core/ro/saft/read';
import { transactionsFromD406, type SourceJournalTransaction } from '../../src/compare/journals';

const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const tag = (name: string, value: string | undefined) =>
  value === undefined ? '' : `<${name}>${escape(value)}</${name}>`;

/** Invented amounts are literal independent expectations, not totals calculated by the fixture. */
export function filed(
  month: string,
  accounts: D406FiledAccount[],
  transactions: D406FiledTransaction[] = [],
) {
  const xml = `<AuditFile xmlns="mfp:anaf:dgti:d406:declaratie:v1">
    <Header><Company><RegistrationNumber>90000003</RegistrationNumber><Name>Comparație Sintetică SRL</Name></Company><SelectionCriteria><SelectionStartDate>${month}-01</SelectionStartDate><SelectionEndDate>${month}-${month.endsWith('02') ? '28' : '31'}</SelectionEndDate></SelectionCriteria><DefaultCurrencyCode>RON</DefaultCurrencyCode></Header>
    <MasterFiles><GeneralLedgerAccounts>${accounts.map((a) => `<Account>${tag('AccountID', a.id)}${tag('StandardAccountID', a.standard)}${tag('OpeningDebitBalance', a.openingDebit)}${tag('OpeningCreditBalance', a.openingCredit)}${tag('ClosingDebitBalance', a.closingDebit)}${tag('ClosingCreditBalance', a.closingCredit)}</Account>`).join('')}</GeneralLedgerAccounts></MasterFiles>
    <GeneralLedgerEntries><Journal><JournalID>synthetic</JournalID>${transactions.map((t) => `<Transaction>${tag('TransactionID', t.id)}${tag('Period', t.period)}${tag('PeriodYear', t.periodYear)}${tag('TransactionDate', t.date)}${t.lines.map((line) => `<TransactionLine>${tag('AccountID', line.account)}<${line.side === 'debit' ? 'DebitAmount' : 'CreditAmount'}>${tag('Amount', line.amount?.amount)}</${line.side === 'debit' ? 'DebitAmount' : 'CreditAmount'}>${(line.tax ?? []).map((tax) => `<TaxInformation>${tag('TaxCode', tax.code)}${tag('TaxBase', tax.base)}<TaxAmount>${tag('Amount', tax.amount)}</TaxAmount></TaxInformation>`).join('')}</TransactionLine>`).join('')}</Transaction>`).join('')}</Journal></GeneralLedgerEntries>
  </AuditFile>`;
  return readD406(new TextEncoder().encode(xml));
}

const line = (account: string, side: 'debit' | 'credit', amount: string) => ({
  account,
  side,
  amount: { amount },
});
const transaction = (
  month: string,
  id: string,
  lines: D406FiledTransaction['lines'],
): D406FiledTransaction => ({
  id: `${month}/${id}`,
  period: month.slice(5),
  periodYear: month.slice(0, 4),
  date: `${month}-05`,
  lines,
});
const account = (
  id: string,
  opening: string,
  closing: string,
  credit = false,
): D406FiledAccount => ({
  id: `source-${id}`,
  standard: id,
  ...(credit
    ? { openingCredit: opening, closingCredit: closing }
    : { openingDebit: opening, closingDebit: closing }),
});

export function sourceBooks() {
  const first = filed(
    '2026-01',
    [
      account('628', '0', '90'),
      account('626', '0', '40'),
      account('627', '0', '50'),
      account('4426', '0', '12'),
      account('5121', '0', '192', true),
    ],
    [
      transaction('2026-01', 'amount', [
        line('source-628', 'debit', '15'),
        line('source-628', 'debit', '15.00'),
        line('source-5121', 'credit', '30'),
      ]),
      transaction('2026-01', 'account', [
        line('source-626', 'debit', '40'),
        line('source-5121', 'credit', '40'),
      ]),
      transaction('2026-01', 'missing', [
        line('source-627', 'debit', '50'),
        line('source-5121', 'credit', '50'),
      ]),
      transaction('2026-01', 'tax', [
        line('source-628', 'debit', '60'),
        {
          ...line('source-4426', 'debit', '12'),
          tax: [{ code: 'SYN-A', base: '60', amount: '12' }],
        },
        line('source-5121', 'credit', '72'),
      ]),
    ],
  );
  const second = filed(
    '2026-02',
    [
      account('628', '90', '140'),
      account('626', '40', '60'),
      account('627', '50', '80'),
      account('4426', '12', '20'),
      account('5121', '192', '300', true),
    ],
    [
      transaction('2026-02', 'amount', [
        line('source-628', 'debit', '10'),
        line('source-5121', 'credit', '10'),
      ]),
      transaction('2026-02', 'account', [
        line('source-626', 'debit', '20'),
        line('source-5121', 'credit', '20'),
      ]),
      transaction('2026-02', 'missing', [
        line('source-627', 'debit', '30'),
        line('source-5121', 'credit', '30'),
      ]),
      transaction('2026-02', 'tax', [
        line('source-628', 'debit', '40'),
        { ...line('source-4426', 'debit', '8'), tax: [{ code: 'SYN-A', base: '40', amount: '8' }] },
        line('source-5121', 'credit', '48'),
      ]),
    ],
  );
  return [first, second];
}

export const mapping = (account: string) =>
  account.startsWith('source-') ? account.slice(7) : undefined;

export function sourceJournal(): SourceJournalTransaction[] {
  return sourceBooks()
    .flatMap((file) =>
      transactionsFromD406(file, 'synthetic', (_journal, transaction) => transaction.id!),
    )
    .map((entry) => ({
      ...entry,
      // The deductible amount and period are supplied synthetic evidence outside D406.
      taxEntries: entry.reference.endsWith('/tax')
        ? [
            {
              code: 'SYN-A',
              base: entry.reference.startsWith('2026-01') ? '60' : '40',
              tax: entry.reference.startsWith('2026-01') ? '12' : '8',
              deductible: entry.reference.startsWith('2026-01') ? '12' : '8',
              period: entry.reference.slice(0, 7),
            },
          ]
        : [],
    }));
}
