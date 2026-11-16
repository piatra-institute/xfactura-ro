import { chartAmendments, referenceChart } from 'xfactura-core/ro/chart';
import type { GeneralJournalInput } from 'xfactura-core/ro/treatments/ledger';
import type { D406Filed } from 'xfactura-core/ro/saft/read';
import type { LocalDate } from 'xfactura-core/time';
import { add, amount, delta } from '../compare/decimal';
import type { MigrationJournalInput } from '../treatments/journal';
import { money, negate } from './amounts';
import { itemKey } from './translate';
import type { ReplayMapping } from './view';

/** One opening balance as posted: debit-positive, per engine account and, on a control
 * account, per party. */
export type OpeningBalance = {
  account: string;
  party?: string;
  net: string;
  tax: boolean;
  sourceAccounts: string[];
};

export type OpeningRefusal = { code: string; sourceAccount: string };

const books = new Map(
  [...referenceChart.accounts, ...chartAmendments.flatMap((amendment) => amendment.accounts)].map(
    (account) => [account.code, account.book],
  ),
);
/** Whether an engine account is kept outside the balance sheet's double entry (classes 8 and
 * 9: off-balance and management accounts), as the engine's chart books it. */
export const outsideDoubleEntry = (code: string) =>
  (books.get(code) ?? books.get(code.split('.')[0]!) ?? 'general') !== 'general';

const net = (debit: string | undefined, credit: string | undefined) =>
  debit === undefined && credit === undefined
    ? null
    : (() => {
        const d = amount(debit ?? '0');
        const c = amount(credit ?? '0');
        return d === null || c === null ? null : delta(d, c);
      })();

/**
 * The first period's opening balances, as its master files state them. A control account's
 * balance goes to its partners when their own opening balances add up to it, otherwise to the
 * party the mapping binds the account to; without either, the opening is refused.
 * Accounts that state no opening are counted, never opened at zero. Off-balance and management
 * accounts are single entries without a counterpart, which no balanced entry can carry: they
 * are returned apart.
 */
export function openingBalances(
  filed: D406Filed,
  mapping: ReplayMapping,
): { balances: OpeningBalance[]; outside: OpeningBalance[]; unknown: number } | OpeningRefusal {
  const merged = new Map<string, OpeningBalance>();
  let unknown = 0;
  const put = (balance: Omit<OpeningBalance, 'sourceAccounts'>, source: string) => {
    const key = JSON.stringify([balance.account, balance.party ?? null]);
    const current = merged.get(key);
    if (current) {
      current.net = add(current.net, balance.net)!;
      if (!current.sourceAccounts.includes(source)) current.sourceAccounts.push(source);
    } else merged.set(key, { ...balance, sourceAccounts: [source] });
  };
  const partners = [
    ...filed.masterFiles.customers.map((record) => ({ record, role: 'customer' as const })),
    ...filed.masterFiles.suppliers.map((record) => ({ record, role: 'supplier' as const })),
  ];
  for (const account of filed.masterFiles.accounts) {
    const id = account.id ?? '';
    const balance = net(account.openingDebit, account.openingCredit);
    if (balance === null) {
      unknown++;
      continue;
    }
    if (balance === '0') continue;
    const target = mapping.account(id);
    if (!target) return { code: 'OPENING_ACCOUNT_UNMAPPED', sourceAccount: id };
    const kind = target.controlKind;
    if (!kind || kind === 'tax' || kind === 'retail') {
      put({ account: target.code, net: balance, tax: kind === 'tax' }, id);
      continue;
    }
    const own = partners
      .filter(({ record }) => record.account === id)
      .map(({ record, role }) => ({
        party: record.id ? mapping.partyOf({ origin: 'd406', role, id: record.id }) : undefined,
        net: net(record.openingDebit, record.openingCredit) ?? '0',
      }))
      .filter((item) => item.net !== '0');
    const total = own.reduce((sum, item) => add(sum, item.net)!, '0');
    if (own.length && total === balance && own.every((item) => item.party)) {
      for (const item of own)
        put({ account: target.code, party: item.party!, net: item.net, tax: false }, id);
      continue;
    }
    const binding = target.party;
    const party =
      binding?.kind === 'source'
        ? mapping.partyOf(binding.source)
        : binding?.kind === 'placeholder'
          ? mapping.placeholderParty(binding.key)
          : undefined;
    if (!party) return { code: 'OPENING_PARTY_UNKNOWN', sourceAccount: id };
    put({ account: target.code, party, net: balance, tax: false }, id);
  }
  const balances = [...merged.values()].filter((item) => item.net !== '0');
  return {
    balances: balances.filter((item) => !outsideDoubleEntry(item.account)),
    outside: balances.filter((item) => outsideDoubleEntry(item.account)),
    unknown,
  };
}

export type OpeningInputs = {
  general: GeneralJournalInput;
  migration: MigrationJournalInput;
  newItems: { ref: string; key: string }[];
};

/**
 * The opening as `ledger.general` takes it, and as `migration.journal` takes it when the general
 * journal refuses a balance. `ledger.general` records no tax entries, so it cannot carry a VAT
 * account's balance; in the journal replay such a line carries one entry coded `CARRIED`, with
 * no base and no tax of its own, booking the filed balance: input VAT on a debit, output on a
 * credit, not exigible on 4428, and in no VAT period of these books.
 */
export function openingInputs(
  balances: readonly OpeningBalance[],
  context: {
    date: LocalDate;
    evidenceId: string;
    source: string;
    partyId: (key: string) => string | undefined;
  },
): OpeningInputs | OpeningRefusal {
  const lines: GeneralJournalInput['lines'] = [];
  const newItems: GeneralJournalInput['newItems'] = [];
  const keys: { ref: string; key: string }[] = [];
  const taxes: MigrationJournalInput['taxEntries'] = [];
  for (const balance of balances) {
    const side = balance.net.startsWith('-') ? 'C' : 'D';
    const value = money(balance.net.startsWith('-') ? negate(balance.net) : balance.net);
    if (value === null)
      return { code: 'OPENING_AMOUNT_FORMAT', sourceAccount: balance.sourceAccounts[0]! };
    const line: GeneralJournalInput['lines'][number] = {
      account: balance.account,
      side,
      amount: value,
    };
    if (balance.party) {
      const partyId = context.partyId(balance.party);
      if (!partyId)
        return { code: 'OPENING_PARTY_UNAVAILABLE', sourceAccount: balance.sourceAccounts[0]! };
      const ref = `o${newItems.length + 1}`;
      newItems.push({ ref, partyId, mayReverse: true });
      keys.push({ ref, key: itemKey(balance.account, balance.party, null, 'RON') });
      line.newItem = ref;
      line.partyId = partyId;
    }
    if (balance.tax) {
      const pending = balance.account.split('.')[0] === '4428';
      taxes.push({
        key: `carried-${lines.length}`,
        tax: 'VAT',
        code: 'CARRIED',
        direction: side === 'D' ? 'input' : 'output',
        base: '0.00',
        amount: '0.00',
        deductible: side === 'D' ? value : '0.00',
        booked: value,
        taxPoint: context.date,
        exigibility: pending ? null : context.date,
        taxPeriod: null,
        line: lines.length,
        attributes: { role: 'carried' },
      });
    }
    lines.push(line);
  }
  const description = 'Solduri inițiale preluate din D406';
  return {
    general: {
      date: context.date,
      purpose: 'opening',
      reference: 'D406-SOLD-INITIAL',
      description,
      evidenceId: context.evidenceId,
      lines,
      newItems,
    },
    migration: {
      source: context.source,
      reference: `opening/${context.date}`,
      evidenceId: context.evidenceId,
      date: context.date,
      journalCode: 'DESCHIDERE',
      description,
      lines: lines.map(({ newItem, partyId, account, side, amount }) => ({
        account,
        side,
        amount,
        ...(partyId ? { partyId } : {}),
        ...(newItem ? { newItem } : {}),
      })),
      newItems,
      taxEntries: taxes,
    },
    newItems: keys,
  };
}
