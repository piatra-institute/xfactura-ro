import { requireCondition } from '../errors';
import { isSupportedCurrency } from '../money';
import { Amount, dateSchema } from '../values';
import { sourceXml, type XmlElement } from '../xml/source-xml';
import {
  bankAccount,
  bankNumber,
  signedBankAmount,
  bankFileLimits,
  type BankStatementDocument,
  type BankEntryDocument,
} from './statement-document';

export function parseCamt(bytes: Uint8Array): BankStatementDocument[] {
  const root = sourceXml(bytes),
    ns = root.uri;
  requireCondition(
    root.local === 'Document' &&
      /^urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.(02|08)$/.test(ns),
    'CAMT_VERSION',
    'Sunt acceptate documente camt.053.001.02 sau camt.053.001.08.',
  );
  const children = (node: XmlElement | undefined, name: string) =>
    node?.children.filter((child) => child.local === name && child.uri === ns) ?? [];
  const one = (
    node: XmlElement | undefined,
    name: string,
    optional = false,
  ): XmlElement | undefined => {
    const found = children(node, name);
    requireCondition(
      found.length <= 1 && (optional || found.length === 1),
      'CAMT_FIELD',
      `Câmp camt lipsă sau repetat: ${name}.`,
    );
    return found[0];
  };
  const value = (node: XmlElement | undefined, name: string, optional = false) => {
    const element = one(node, name, optional);
    if (!element) return null;
    requireCondition(
      element.children.length === 0 &&
        element.text.trim().length > 0 &&
        element.text.length <= 8000,
      'CAMT_FIELD',
      `Conținut camt invalid: ${name}.`,
    );
    return element.text.trim();
  };
  const path = (node: XmlElement | undefined, ...names: string[]) =>
    names.reduce((next, name) => one(next, name, true), node);
  // Every amount in a statement is in its account's currency.
  let accountCurrency = '';
  const currency = (node: XmlElement) =>
    requireCondition(
      node.attributes.Ccy === accountCurrency,
      'UNSUPPORTED_CURRENCY',
      'Toate valorile extrasului trebuie să fie în moneda contului.',
    );
  const amount = (node: XmlElement | undefined) => {
    requireCondition(node && node.children.length === 0, 'CAMT_AMOUNT', 'Lipsește suma bancară.');
    currency(node);
    return bankNumber(node.text.trim());
  };
  const dateTime = (raw: string) => {
    requireCondition(
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(
        raw,
      ) && Number.isFinite(Date.parse(raw)),
      'CAMT_DATE_TIME',
      'Data și ora bancară trebuie să includă fusul orar.',
    );
    return { date: dateSchema.parse(raw.slice(0, 10)), raw };
  };
  const reportedDate = (node: XmlElement | undefined, optional = false) => {
    if (!node && optional) return { date: null, raw: null };
    const dt = value(node, 'Dt', true),
      dtm = value(node, 'DtTm', true);
    requireCondition(
      Boolean(dt) !== Boolean(dtm),
      'CAMT_DATE',
      'Data bancară lipsește sau este ambiguă.',
    );
    return dt ? { date: dateSchema.parse(dt), raw: null } : dateTime(dtm!);
  };
  const pagination = (node: XmlElement | undefined) => {
    const pages = one(node, 'MsgPgntn', true);
    if (pages)
      requireCondition(
        value(pages, 'PgNb') === '1' && ['true', '1'].includes(value(pages, 'LastPgInd')!),
        'BANK_PARTIAL_STATEMENT',
        'Extrasele paginate necesită toate paginile într-un tratament separat.',
      );
  };
  const allAmounts = (node: XmlElement) => {
    if (node.uri === ns && node.attributes.Ccy !== undefined) currency(node);
    for (const child of node.children) allAmounts(child);
  };
  const party = (node: XmlElement | undefined) =>
    value(
      node?.children.some((c) => c.local === 'Pty' && c.uri === ns) ? one(node, 'Pty') : node,
      'Nm',
      true,
    );
  const charges = (
    node: XmlElement | undefined,
    scope: 'entry' | 'transaction',
  ): BankEntryDocument['charges'] => {
    if (!node) return [];
    const found: BankEntryDocument['charges'] = [];
    const visit = (n: XmlElement) => {
      if (n.uri === ns && n.attributes.Ccy !== undefined && n.children.length === 0)
        found.push({ amount: amount(n), scope, kind: n.local });
      else for (const child of n.children) visit(child);
    };
    visit(node);
    return found;
  };
  const document = one(root, 'BkToCstmrStmt')!,
    header = one(document, 'GrpHdr')!;
  pagination(header);
  const messageId = value(header, 'MsgId')!;
  return children(document, 'Stmt').map((statement, ordinal) => {
    pagination(statement);
    const ownAccount = one(statement, 'Acct'),
      account = bankAccount(value(one(ownAccount, 'Id'), 'IBAN')!);
    accountCurrency = value(ownAccount, 'Ccy') ?? '';
    requireCondition(
      isSupportedCurrency(accountCurrency),
      'UNSUPPORTED_CURRENCY',
      'Moneda contului extrasului nu este acceptată.',
    );
    allAmounts(statement);
    const balances = children(statement, 'Bal');
    const getBalance = (code: string) => {
      const selected = balances.filter(
        (balance) => value(path(balance, 'Tp', 'CdOrPrtry'), 'Cd', true) === code,
      );
      requireCondition(
        selected.length === 1,
        'CAMT_BALANCE',
        `Sold contabil ${code} lipsă sau ambiguu.`,
      );
      return {
        amount: signedBankAmount(amount(one(selected[0], 'Amt')), value(selected[0], 'CdtDbtInd')!),
        date: reportedDate(one(selected[0], 'Dt')).date!,
      };
    };
    const opening = getBalance('OPBD'),
      closing = getBalance('CLBD'),
      reportedRange = one(statement, 'FrToDt', true),
      rawFrom = reportedRange ? value(reportedRange, 'FrDtTm')! : null,
      rawTo = reportedRange ? value(reportedRange, 'ToDtTm')! : null;
    let from = opening.date,
      to = closing.date;
    if (rawFrom && rawTo) {
      from = dateTime(rawFrom).date;
      to = dateTime(rawTo).date;
      requireCondition(
        /T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(rawFrom),
        'BANK_PARTIAL_INTERVAL',
        'Intervalul bancar nu începe la începutul unei zile.',
      );
      if (/T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(rawTo))
        to = new Date(Date.parse(`${to}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      else
        requireCondition(
          /T23:59:59(?:\.9+|\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(rawTo),
          'BANK_PARTIAL_INTERVAL',
          'Intervalul bancar nu acoperă zile întregi.',
        );
      requireCondition(
        rawFrom.slice(-6) === rawTo.slice(-6) || (rawFrom.endsWith('Z') && rawTo.endsWith('Z')),
        'BANK_INTERVAL_ZONE',
        'Intervalele cu schimbare de fus orar necesită revizuire distinctă.',
      );
    }
    const entries: BankEntryDocument[] = children(statement, 'Ntry').map((entry, index) => {
      const status = one(entry, 'Sts')!,
        code = status.children.length ? value(status, 'Cd') : status.text.trim();
      requireCondition(
        code === 'BOOK',
        'BANK_ENTRY_STATUS',
        'Sunt acceptate numai înregistrări bancare contabilizate, cu status BOOK.',
      );
      const date = reportedDate(one(entry, 'BookgDt')),
        valueDate = reportedDate(one(entry, 'ValDt', true), true),
        direction = value(entry, 'CdtDbtInd')!,
        signed = signedBankAmount(amount(one(entry, 'Amt')), direction),
        rawReversal = value(entry, 'RvslInd', true);
      requireCondition(
        rawReversal === null || ['true', 'false', '1', '0'].includes(rawReversal),
        'CAMT_REVERSAL',
        'Indicator de reversare invalid.',
      );
      const transactions = children(entry, 'NtryDtls').flatMap((details) =>
        children(details, 'TxDtls'),
      );
      requireCondition(
        transactions.length <= bankFileLimits.detailsPerEntry,
        'BANK_DETAIL_LIMIT',
        'Prea multe detalii într-o înregistrare bancară.',
      );
      const chargeAmounts = [
        ...charges(one(entry, 'Chrgs', true), 'entry'),
        ...transactions.flatMap((tx) => charges(one(tx, 'Chrgs', true), 'transaction')),
      ];
      const details = transactions.map((tx) => {
        const refs = one(tx, 'Refs', true),
          related = one(tx, 'RltdPties', true),
          remittance = one(tx, 'RmtInf', true),
          references: Record<string, string> = {};
        for (const name of ['AcctSvcrRef', 'EndToEndId', 'TxId', 'InstrId', 'PmtInfId', 'MndtId']) {
          const v = value(refs, name, true);
          if (v) references[name] = v;
        }
        const creditorReference = value(path(remittance, 'Strd', 'CdtrRefInf'), 'Ref', true);
        if (creditorReference) references.CreditorReference = creditorReference;
        const money = one(tx, 'Amt', true) ?? path(tx, 'AmtDtls', 'TxAmt', 'Amt');
        return {
          references,
          amount: money
            ? signedBankAmount(amount(money), value(tx, 'CdtDbtInd', true) ?? direction)
            : null,
          remittance: children(remittance, 'Ustrd').map((row) => row.text.trim()),
          debtor: party(one(related, 'Dbtr', true)),
          creditor: party(one(related, 'Cdtr', true)),
          debtorAccount: value(path(related, 'DbtrAcct', 'Id'), 'IBAN', true),
          creditorAccount: value(path(related, 'CdtrAcct', 'Id'), 'IBAN', true),
        };
      });
      requireCondition(
        chargeAmounts.length ||
          details.length === 0 ||
          details.some((row) => row.amount === null) ||
          details.reduce((sum, row) => sum.plus(row.amount!), new Amount(0)).eq(signed),
        'CAMT_DETAIL_TOTAL',
        'Detaliile tranzacțiilor nu explică suma înregistrării.',
      );
      const bankReference =
          value(entry, 'AcctSvcrRef', true) ??
          (details.length === 1 ? (details[0].references.AcctSvcrRef ?? null) : null),
        transaction = one(entry, 'BkTxCd', true),
        domain = one(transaction, 'Domn', true),
        family = one(domain, 'Fmly', true),
        proprietary = one(transaction, 'Prtry', true),
        transactionCode = [
          value(domain, 'Cd', true),
          value(family, 'Cd', true),
          value(family, 'SubFmlyCd', true),
          value(proprietary, 'Cd', true),
          value(proprietary, 'Issr', true),
        ]
          .filter(Boolean)
          .join('/');
      const reference =
        [
          ...new Set(
            [
              ...details.flatMap((row) => row.remittance),
              value(entry, 'AddtlNtryInf', true),
            ].filter((v): v is string => Boolean(v)),
          ),
        ].join('\n') ||
        bankReference ||
        value(entry, 'NtryRef', true) ||
        transactionCode ||
        'Înregistrare bancară';
      return {
        ordinal: index,
        date: date.date!,
        valueDate: valueDate.date,
        bookingDateTime: date.raw,
        valueDateTime: valueDate.raw,
        amount: signed,
        reference,
        bankReference,
        entryReference: value(entry, 'NtryRef', true),
        customerReference: details.length === 1 ? (details[0].references.EndToEndId ?? null) : null,
        transactionCode,
        reversal: rawReversal === 'true' || rawReversal === '1',
        raw: null,
        charges: chargeAmounts,
        details,
      };
    });
    const summary = one(statement, 'TxsSummry', true);
    for (const [name, subset] of [
      ['TtlNtries', entries],
      ['TtlCdtNtries', entries.filter((row) => new Amount(row.amount).gt(0))],
      ['TtlDbtNtries', entries.filter((row) => new Amount(row.amount).lt(0))],
    ] as const) {
      const total = one(summary, name, true);
      if (!total) continue;
      const count = value(total, 'NbOfNtries', true),
        sum = value(total, 'Sum', true);
      requireCondition(
        (count === null || (/^\d+$/.test(count) && BigInt(count) === BigInt(subset.length))) &&
          (sum === null ||
            new Amount(bankNumber(sum)).eq(
              subset.reduce((n, row) => n.plus(new Amount(row.amount).abs()), new Amount(0)),
            )),
        'CAMT_SUMMARY',
        'Sumarul camt nu corespunde înregistrărilor.',
      );
    }
    return {
      ordinal,
      format: 'camt.053',
      sourceId: value(statement, 'Id')!,
      messageId,
      sequence: value(statement, 'ElctrncSeqNb', true) ?? value(statement, 'LglSeqNb', true),
      bankAccount: account,
      currency: accountCurrency,
      from,
      to,
      openingDate: opening.date,
      closingDate: closing.date,
      opening: opening.amount,
      closing: closing.amount,
      reportedFrom: rawFrom,
      reportedTo: rawTo,
      entries,
    };
  });
}
