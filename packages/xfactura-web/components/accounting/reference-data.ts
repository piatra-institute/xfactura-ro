'use client';

import { useMemo } from 'react';
import { formatDate, formatMoney } from './format';
import type { ComboOption } from './ui';
import { useAccountingData } from './use-data';
import { useWorkspace, type List } from './workspace';

/** An account of the chart as `accounts.list` states it. */
export type Account = {
  code: string;
  name: string;
  postable: boolean;
  /** The open-item kind its lines name (`payable`, `receivable`, …), `tax`, `retail` or null. */
  controlKind: string | null;
  validFrom: string;
  validTo: string | null;
};

/** A partner as `parties.list` states it. */
export type Party = {
  id: string;
  kind: string;
  country: string;
  taxId: string | null;
  name: string;
};

/** An open item as `openItems.list` states it; balances are the engine's decimal strings. */
export type OpenItem = {
  id: string;
  kind: string;
  account: string;
  partyId: string;
  party: string | null;
  document: string | null;
  currency: string;
  balance: string;
  balanceCurrency: string;
  dueDate: string | null;
};

/** Whether lines on an account of this control kind name an open item and its partner. */
export const itemControlled = (kind: string | null) =>
  kind !== null && kind !== 'tax' && kind !== 'retail';

/** The VAT accounts (4426, 4427, 4428), booked only with the invoice that carries the tax. */
export const isVatAccount = (account: Account) => account.controlKind === 'tax';

/** The chart of accounts, every page of it; kept on screen while the workspace refreshes. */
export function useAccounts() {
  const { can } = useWorkspace();
  const read = useAccountingData<Account[]>(
    'accounts.list',
    { limit: 1000 },
    can('accounts.list'),
    true,
  );
  const byCode = useMemo(
    () => new Map((read.data ?? []).map((account) => [account.code, account])),
    [read.data],
  );
  return { accounts: read.data, byCode, error: read.error };
}

/** The accounts a choice offers, by code and name, held to those valid on a day when one is given. */
export function accountOptions(
  accounts: readonly Account[] | null,
  keep: (account: Account) => boolean,
  date?: string | null,
): ComboOption[] {
  return (accounts ?? [])
    .filter(
      (account) =>
        account.postable &&
        keep(account) &&
        (!date ||
          (account.validFrom <= date && (account.validTo === null || account.validTo >= date))),
    )
    .map((account) => ({ id: account.code, code: account.code, name: account.name }));
}

export function useParties() {
  const { can } = useWorkspace();
  const read = useAccountingData<List<Party>>('parties.list', {}, can('parties.list'));
  return { parties: read.data?.items ?? null, error: read.error };
}

export function useOpenItems(enabled = true) {
  const { can } = useWorkspace();
  const read = useAccountingData<List<OpenItem>>(
    'openItems.list',
    {},
    enabled && can('openItems.list'),
  );
  return { items: read.data?.items ?? null, error: read.error };
}

/** An open item as a choice: its document, due date and balance as the engine states them. */
export function openItemOption(item: OpenItem, withParty = false): ComboOption {
  const balance = formatMoney(item.balanceCurrency.replace(/^-/, ''), item.currency);
  return {
    id: item.id,
    code: item.document ?? undefined,
    name: [
      withParty ? (item.party ?? undefined) : undefined,
      item.document ? undefined : 'Fără număr',
      item.dueDate ? `scadentă ${formatDate(item.dueDate)}` : undefined,
      `sold ${balance}`,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}
