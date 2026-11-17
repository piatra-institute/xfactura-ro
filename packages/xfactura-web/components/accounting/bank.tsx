'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ApiError } from './api';
import { BookingProposal } from './documents';
import { formatDate, formatMinor, formatMoney } from './format';
import { followLink, useAccountingNavigation } from './navigation';
import {
  accountOptions,
  openItemOption,
  useAccounts,
  useOpenItems,
  type Account,
  type OpenItem,
} from './reference-data';
import {
  Button,
  Chip,
  ComboBox,
  DateField,
  Dialog,
  EmptyState,
  MoneyField,
  Select,
  TextField,
  icons,
  type ComboOption,
  type Tone,
} from './ui';
import { useAccountingData } from './use-data';
import { useWorkspace, type List } from './workspace';
import type { ProposalView } from 'xfactura-api/contracts';

type TreasuryAccount = {
  id: string;
  kind: 'bank' | 'cash';
  name: string;
  iban: string | null;
  currency: string;
  ledgerAccount: string;
};
type MovementState = 'unexplained' | 'proposed' | 'approved' | 'settled';
type Movement = {
  id: string;
  treasuryAccountId: string;
  bookingDate: string;
  /** Null for one person's pay, to a reader who may not read pay (`Plată salarii`). */
  amount: string | null;
  currency: string;
  reference: string | null;
  counterparty: string | null;
  state: MovementState;
};
type Money = { minor: string; currency: string };
type Summary = {
  cash: {
    accounts: { id: string; balance: Money; ledgerBalance: Money }[];
  };
};

const stateLabels: Record<MovementState, { label: string; tone: Tone }> = {
  unexplained: { label: 'De explicat', tone: 'warning' },
  proposed: { label: 'Propusă', tone: 'info' },
  approved: { label: 'Aprobată', tone: 'info' },
  settled: { label: 'Explicată', tone: 'success' },
};
const filters = [
  { id: 'unexplained', label: 'De explicat', states: ['unexplained'] },
  { id: 'review', label: 'În verificare', states: ['proposed', 'approved'] },
  { id: 'settled', label: 'Explicate', states: ['settled'] },
  { id: 'all', label: 'Toate', states: ['unexplained', 'proposed', 'approved', 'settled'] },
] as const;

/** An IBAN in groups of four, as it is printed. */
const printedIban = (iban: string) => iban.replace(/(.{4})(?=.)/g, '$1 ');

export default function Bank() {
  const { can } = useWorkspace();
  const { params, href } = useAccountingNavigation();
  const accounts = useAccountingData<List<TreasuryAccount>>(
    'treasury.accounts',
    {},
    can('treasury.accounts'),
  );
  const summary = useAccountingData<Summary>('company.summary', {}, can('company.summary'));
  const [creating, setCreating] = useState(false);
  // The chart and the open items are read once for every explanation the list may open.
  const { accounts: chart } = useAccounts();
  const { items: openItems } = useOpenItems();
  const list = accounts.data?.items ?? null;
  const chosen = list?.find((account) => account.id === params.get('bankAccount')) ?? list?.[0];
  const balances = new Map(
    (summary.data?.cash.accounts ?? []).map((account) => [account.id, account]),
  );
  const canCreate = can('treasury.createAccount');
  return (
    <div className="acc-bank">
      {accounts.error ? (
        <p role="alert" className="acc-error">
          {accounts.error}
        </p>
      ) : null}
      {!list ? (
        <p className="acc-hint" aria-busy="true">
          Se încarcă conturile…
        </p>
      ) : list.length === 0 ? (
        <EmptyState
          message="Nu există conturi bancare sau case."
          action={canCreate ? { label: 'Cont nou', onPress: () => setCreating(true) } : undefined}
        />
      ) : (
        <section aria-labelledby="acc-treasury-heading">
          <div className="acc-section-heading">
            <h2 id="acc-treasury-heading">Conturi</h2>
            {canCreate ? (
              <Button size="small" onPress={() => setCreating(true)}>
                {icons.plus}
                Cont nou
              </Button>
            ) : null}
          </div>
          <ul className="acc-treasury-list">
            {list.map((account) => {
              const balance = balances.get(account.id);
              return (
                <li key={account.id}>
                  <a
                    className="acc-treasury-account"
                    href={href('bank', { bankAccount: account.id })}
                    aria-current={account.id === chosen?.id ? 'true' : undefined}
                    onClick={followLink}
                  >
                    <span className="acc-treasury-name">{account.name}</span>
                    <span className="acc-treasury-meta">
                      {account.kind === 'bank' && account.iban ? printedIban(account.iban) : 'Casă'}
                    </span>
                    {balance ? (
                      <span className="acc-treasury-balance">
                        {formatMinor(balance.balance.minor, balance.balance.currency)}
                      </span>
                    ) : summary.error ? (
                      <span className="acc-treasury-meta">Sold necunoscut: {summary.error}</span>
                    ) : can('company.summary') ? (
                      <span className="acc-treasury-balance" aria-busy="true">
                        …
                      </span>
                    ) : null}
                    {balance && balance.balance.currency !== balance.ledgerBalance.currency ? (
                      <span className="acc-treasury-meta">
                        {formatMinor(balance.ledgerBalance.minor, balance.ledgerBalance.currency)}{' '}
                        în registre
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {chosen ? <Movements account={chosen} chart={chart} openItems={openItems} /> : null}
      {creating ? <TreasuryDialog chart={chart} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

/** The movements of one account, by state, each explained in place. */
function Movements({
  account,
  chart,
  openItems,
}: {
  account: TreasuryAccount;
  chart: Account[] | null;
  openItems: OpenItem[] | null;
}) {
  const { params, filter, href } = useAccountingNavigation();
  const shown = filters.find((choice) => choice.id === params.get('movementState')) ?? filters[0];
  const movements = useAccountingData<List<Movement>>('bank.movements', {
    treasuryAccountId: account.id,
  });
  const [open, setOpen] = useState<string | null>(null);
  // A movement explained here stays in the list, with its proposal, until the state shown changes.
  const [kept, setKept] = useState<{ filter: string; ids: string[] }>({ filter: '', ids: [] });
  const keptIds = kept.filter === shown.id ? kept.ids : [];
  const all = movements.data?.items ?? null;
  const rows = (all ?? []).filter(
    (movement) =>
      (shown.states as readonly string[]).includes(movement.state) || keptIds.includes(movement.id),
  );
  const counts = (states: readonly string[]) =>
    (all ?? []).filter((movement) => states.includes(movement.state)).length;
  return (
    <section className="acc-movements" aria-labelledby="acc-movements-heading">
      <div className="acc-section-heading">
        <h2 id="acc-movements-heading">Mișcările din {account.name}</h2>
      </div>
      <div className="acc-filters">
        <Select
          label="Stare"
          options={filters.map((choice) => ({
            id: choice.id,
            label: all ? `${choice.label} (${counts(choice.states)})` : choice.label,
          }))}
          value={shown.id}
          onChange={(choice) => {
            setKept({ filter: '', ids: [] });
            filter({ movementState: choice === filters[0].id ? null : choice });
          }}
        />
      </div>
      {movements.error ? (
        <p role="alert" className="acc-error">
          {movements.error}
        </p>
      ) : null}
      {!all ? (
        <p className="acc-hint" aria-busy="true">
          Se încarcă mișcările…
        </p>
      ) : rows.length === 0 ? (
        <p className="acc-empty">
          {all.length === 0 ? (
            <>
              Contul nu are mișcări importate. Extrasele se importă din{' '}
              <a href={href('documents')} onClick={followLink}>
                Documente
              </a>
              .
            </>
          ) : shown.id === 'unexplained' ? (
            'Toate mișcările sunt explicate sau în verificare.'
          ) : (
            'Nicio mișcare în această stare.'
          )}
        </p>
      ) : (
        <div className="acc-ledger-frame">
          <table className="acc-ledger-table acc-movements-table">
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Contrapartidă</th>
                <th scope="col">Referință</th>
                <th scope="col" className="acc-numeric">
                  Sumă
                </th>
                <th scope="col">Stare</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((movement) => (
                <MovementRow
                  key={movement.id}
                  movement={movement}
                  chart={chart}
                  openItems={openItems}
                  open={open === movement.id}
                  toggle={() => setOpen((id) => (id === movement.id ? null : movement.id))}
                  onExplained={() => setKept({ filter: shown.id, ids: [...keptIds, movement.id] })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MovementRow({
  movement,
  chart,
  openItems,
  open,
  toggle,
  onExplained,
}: {
  movement: Movement;
  chart: Account[] | null;
  openItems: OpenItem[] | null;
  open: boolean;
  toggle: () => void;
  onExplained: () => void;
}) {
  const { can } = useWorkspace();
  const { href } = useAccountingNavigation();
  const state = stateLabels[movement.state];
  const amount = movement.amount === null ? null : formatMoney(movement.amount, movement.currency);
  const name = [formatDate(movement.bookingDate), movement.counterparty, amount]
    .filter(Boolean)
    .join(' · ');
  const explainable = movement.state === 'unexplained' && can('bank.settle.propose');
  return (
    <>
      <tr data-movement={movement.id}>
        <td data-label="Data" className="acc-nowrap">
          {formatDate(movement.bookingDate)}
        </td>
        <td data-label="Contrapartidă">{movement.counterparty}</td>
        <td data-label="Referință">{movement.reference}</td>
        <td
          data-label="Sumă"
          className="acc-numeric"
          data-negative={amount?.startsWith('−') || undefined}
        >
          {amount ?? 'Sumă ascunsă (date salariale)'}
        </td>
        <td data-label="Stare">
          <div className="acc-row-actions">
            <Chip tone={state.tone}>{state.label}</Chip>
            {explainable || open ? (
              <Button
                size="small"
                variant={open ? 'quiet' : 'secondary'}
                aria-expanded={open}
                aria-label={open ? `Închide explicația ${name}` : `Explică ${name}`}
                onPress={toggle}
              >
                {open ? 'Închide' : 'Explică'}
              </Button>
            ) : movement.state === 'proposed' || movement.state === 'approved' ? (
              <a href={href('review', { family: 'proposals' })} onClick={followLink}>
                De verificat
              </a>
            ) : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="acc-ledger-detail">
          <td colSpan={5}>
            <Explanation
              movement={movement}
              name={name}
              chart={chart}
              items={openItems}
              onExplained={onExplained}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The explanation of a movement: the open invoice it settles and how much of it, another account
 * (a fee, interest, a transfer) and its amount, or both; sent to `bank.settle` as typed.
 */
function Explanation({
  movement,
  name,
  chart,
  items,
  onExplained,
}: {
  movement: Movement;
  name: string;
  chart: Account[] | null;
  items: OpenItem[] | null;
  onExplained: () => void;
}) {
  const { invoke, act } = useWorkspace();
  const received = !(movement.amount ?? '-').startsWith('-');
  // The movement's own amount, unsigned, as the part a single choice explains.
  const whole = movement.amount?.replace(/^-/, '') ?? null;
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [allocation, setAllocation] = useState<{ value: string | null; key: number }>({
    value: null,
    key: 0,
  });
  const [account, setAccount] = useState<string | null>(null);
  const [lineAmount, setLineAmount] = useState<{ value: string | null; key: number }>({
    value: null,
    key: 0,
  });
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const invoiceChoices = useMemo<ComboOption[]>(
    () =>
      (items ?? [])
        .filter(
          (item) =>
            item.currency === movement.currency &&
            (received
              ? ['receivable', 'unapplied.payment'].includes(item.kind)
              : ['payable', 'unapplied.receipt'].includes(item.kind)),
        )
        .map((item) => openItemOption(item, true)),
    [items, movement.currency, received],
  );
  const otherChoices = useMemo(
    () => accountOptions(chart, (candidate) => candidate.controlKind === null),
    [chart],
  );
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const allocations =
      openItem && allocation.value ? [{ openItem, amount: allocation.value }] : [];
    const lines = account && lineAmount.value ? [{ account, amount: lineAmount.value }] : [];
    if (openItem && !allocation.value) return setProblem('Completează suma decontată.');
    if (account && !lineAmount.value) return setProblem('Completează suma pe cont.');
    if (!allocations.length && !lines.length)
      return setProblem('Alege factura decontată sau un alt cont.');
    setProblem('');
    setBusy(true);
    const made: { proposal?: ProposalView } = {};
    await act(
      async () => {
        made.proposal = await invoke<ProposalView>('bank.settle.propose', {
          movementId: movement.id,
          allocations,
          lines,
        });
      },
      'Explicația a fost pregătită pentru verificare.',
      (reason) => {
        const held =
          reason instanceof ApiError &&
          reason.code === 'SUBJECT_EXISTS' &&
          reason.details &&
          typeof reason.details === 'object'
            ? (reason.details as { proposalId?: unknown }).proposalId
            : undefined;
        if (typeof held === 'string') {
          setProposalId(held);
          onExplained();
        } else setProblem(reason instanceof Error ? reason.message : 'Explicația nu a reușit.');
      },
    );
    if (made.proposal) {
      setProposalId(made.proposal.id);
      onExplained();
    }
    setBusy(false);
  };
  if (proposalId) return <BookingProposal id={proposalId} />;
  return (
    <form
      className="acc-booking acc-explanation"
      aria-label={`Explicația mișcării ${name}`}
      onSubmit={submit}
    >
      <ComboBox
        label="Factură decontată"
        className="acc-booking-wide"
        options={invoiceChoices}
        value={openItem}
        onChange={(chosen) => {
          setOpenItem(chosen);
          if (chosen && !allocation.value && whole)
            setAllocation((current) => ({ value: whole, key: current.key + 1 }));
        }}
        placeholder="Partener sau număr"
        emptyMessage="Nicio factură deschisă potrivită"
      />
      <MoneyField
        key={`a${allocation.key}`}
        label="Sumă decontată"
        currency={movement.currency}
        defaultValue={allocation.value ?? undefined}
        onChange={(value) => setAllocation((current) => ({ ...current, value }))}
      />
      <ComboBox
        label="Alt cont"
        options={otherChoices}
        value={account}
        onChange={(chosen) => {
          setAccount(chosen);
          if (chosen && !openItem && !lineAmount.value && whole)
            setLineAmount((current) => ({ value: whole, key: current.key + 1 }));
        }}
        placeholder="Comision, dobândă, transfer"
        emptyMessage="Niciun cont"
      />
      <MoneyField
        key={`l${lineAmount.key}`}
        label="Sumă pe cont"
        currency={movement.currency}
        defaultValue={lineAmount.value ?? undefined}
        onChange={(value) => setLineAmount((current) => ({ ...current, value }))}
      />
      <Button type="submit" variant="primary" isDisabled={busy}>
        Pregătește explicația
      </Button>
      {problem ? (
        <p role="alert" className="acc-error acc-booking-problem">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

const currencies = ['RON', 'EUR', 'USD', 'GBP', 'CHF', 'HUF', 'PLN', 'CZK', 'BGN', 'MDL'];

/** „Cont nou”: a bank account or a cash register and the ledger account it is kept on. */
function TreasuryDialog({ chart, onClose }: { chart: Account[] | null; onClose: () => void }) {
  const { invoke, act } = useWorkspace();
  const { filter } = useAccountingNavigation();
  const [kind, setKind] = useState<'bank' | 'cash'>('bank');
  const [currency, setCurrency] = useState('RON');
  const [ledgerAccount, setLedgerAccount] = useState<string | null>(null);
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  // Lei are kept on 5121 and 5311, foreign currency on 5124 and 5314.
  const prefix =
    kind === 'bank' ? (currency === 'RON' ? '5121' : '5124') : currency === 'RON' ? '5311' : '5314';
  const ledgerChoices = useMemo(
    () =>
      accountOptions(
        chart,
        (candidate) => candidate.controlKind === null && candidate.code.startsWith(prefix),
      ),
    [chart, prefix],
  );
  const chosenLedger =
    ledgerAccount && ledgerChoices.some((choice) => choice.id === ledgerAccount)
      ? ledgerAccount
      : (ledgerChoices.find((choice) => choice.id === prefix)?.id ?? null);
  return (
    <Dialog
      title="Cont nou"
      isOpen
      onOpenChange={(open) => !open && onClose()}
      isDismissable={false}
    >
      <form
        className="acc-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = (name: string) => String(data.get(name) ?? '').trim();
          if (!chosenLedger) return setProblem('Alege contul contabil.');
          if (!openedOn) return setProblem('Completează data deschiderii.');
          setProblem('');
          setBusy(true);
          const made: { id?: string } = {};
          void act(
            async () => {
              made.id = (
                await invoke<{ id: string }>('treasury.createAccount', {
                  kind,
                  name: value('name'),
                  ...(kind === 'bank' ? { iban: value('iban').replace(/\s+/g, '') } : {}),
                  currency,
                  ledgerAccount: chosenLedger,
                  openedOn,
                })
              ).id;
            },
            'Contul a fost configurat.',
            (reason) =>
              setProblem(reason instanceof Error ? reason.message : 'Contul nu a fost configurat.'),
          ).then((done) => {
            setBusy(false);
            if (done && made.id) {
              filter({ bankAccount: made.id });
              onClose();
            }
          });
        }}
      >
        <Select
          label="Tip"
          options={[
            { id: 'bank', label: 'Cont bancar' },
            { id: 'cash', label: 'Casă' },
          ]}
          value={kind}
          onChange={(chosen) => chosen && setKind(chosen as 'bank' | 'cash')}
        />
        <TextField
          label="Denumire"
          name="name"
          autoFocus
          maxLength={200}
          validate={(value) =>
            value.trim().length >= 2 ? null : 'Scrie o denumire de cel puțin două caractere.'
          }
        />
        {kind === 'bank' ? (
          <TextField
            label="IBAN"
            name="iban"
            maxLength={42}
            validate={(value) =>
              value.replace(/\s+/g, '').length >= 15 ? null : 'Completează IBAN-ul contului.'
            }
          />
        ) : null}
        <div className="acc-form-row">
          <Select
            label="Monedă"
            options={currencies.map((code) => ({ id: code, label: code }))}
            value={currency}
            onChange={(chosen) => chosen && setCurrency(chosen)}
          />
          <ComboBox
            label="Cont contabil"
            options={ledgerChoices}
            value={chosenLedger}
            onChange={setLedgerAccount}
            emptyMessage="Niciun cont potrivit"
          />
        </div>
        <DateField label="Deschis la" value={openedOn} onChange={setOpenedOn} isRequired />
        {problem ? (
          <p role="alert" className="acc-error">
            {problem}
          </p>
        ) : null}
        <div className="acc-form-actions">
          <Button type="submit" variant="primary" isDisabled={busy}>
            Configurează contul
          </Button>
          <Button variant="quiet" onPress={onClose}>
            Renunță
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
