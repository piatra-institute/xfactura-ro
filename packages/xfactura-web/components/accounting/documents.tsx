'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { DropZone, FileTrigger, type FileDropItem } from 'react-aria-components';
import type { ProposalView } from 'xfactura-api/contracts';
import { ApiError, companyPath } from './api';
import { formatDate, formatMoney } from './format';
import { followLink, useAccountingNavigation } from './navigation';
import { accountOptions, isVatAccount, useAccounts, type Account } from './reference-data';
import { ProposalCard } from './review';
import {
  Button,
  Chip,
  ComboBox,
  MonthField,
  EmptyState,
  Select,
  icons,
  type ComboOption,
} from './ui';
import { useAccountingData } from './use-data';
import { useWorkspace, type Evidence, type List } from './workspace';

type DocumentItem = {
  id: string;
  kind: string;
  number: string | null;
  date: string;
  partyId: string | null;
  currency: string | null;
  totals: { net: string; tax: string; gross: string } | null;
  party: { id: string; name: string } | null;
  booked: boolean;
  entryId: string | null;
};

const kindLabels: Record<string, string> = {
  'invoice.received': 'Factură primită',
  'invoice.issued': 'Factură emisă',
  'creditNote.received': 'Notă de credit primită',
  'creditNote.issued': 'Notă de credit emisă',
  'receipt.received': 'Bon fiscal',
  contract: 'Contract',
  'tax.decision': 'Decizie ANAF',
  'tax.statement': 'Fișa contului fiscal',
  'inventory.list': 'Listă de inventar',
  'customs.declaration': 'Declarație vamală',
  'vies.check': 'Verificare VIES',
  zreport: 'Raport Z',
};
const kindChoices = [
  { id: 'all', label: 'Toate' },
  ...Object.entries(kindLabels).map(([id, label]) => ({ id, label })),
];
const bookedChoices = [
  { id: 'all', label: 'Toate' },
  { id: 'unbooked', label: 'Neînregistrate' },
  { id: 'booked', label: 'Înregistrate' },
];
/** The documents whose booking a person prepares here, and the treatment that books each. */
const bookings: Record<string, 'invoices.recognize' | 'invoices.credit'> = {
  'invoice.received': 'invoices.recognize',
  'invoice.issued': 'invoices.recognize',
  'creditNote.received': 'invoices.credit',
  'creditNote.issued': 'invoices.credit',
};
const pageSize = 50;
/** The most documents `documents.list` returns in one page. */
const maxPage = 500;
const isoMonth = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The last day of a month (`YYYY-MM`), as an ISO date. */
const lastDay = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);

export default function Documents() {
  return (
    <div className="acc-documents">
      <Upload />
      <Files />
      <DocumentList />
    </div>
  );
}

/** Files are kept by dropping them here or choosing them; each is kept as evidence at once. */
function Upload() {
  const { can, upload, act } = useWorkspace();
  const [busy, setBusy] = useState(false);
  if (!can('evidence.record')) return null;
  const keep = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    await act(
      async () => {
        for (const file of files) await upload(file);
      },
      files.length === 1
        ? `${files[0]!.name} a fost păstrat.`
        : `${files.length} fișiere au fost păstrate.`,
    );
    setBusy(false);
  };
  return (
    <DropZone
      className="acc-dropzone"
      aria-label="Încarcă documente"
      isDisabled={busy}
      onDrop={async (event) => {
        const files = await Promise.all(
          event.items
            .filter((item): item is FileDropItem => item.kind === 'file')
            .map((item) => item.getFile()),
        );
        await keep(files);
      }}
    >
      {icons.upload}
      <span className="acc-dropzone-text">
        {busy ? 'Se păstrează…' : 'Trage aici fișierele sau'}
      </span>
      <FileTrigger allowsMultiple onSelect={(list) => void keep(list ? [...list] : [])}>
        <Button variant="primary" size="small" isDisabled={busy}>
          Alege fișiere
        </Button>
      </FileTrigger>
    </DropZone>
  );
}

/** What a kept file may be imported as, from its name and type: the engine decides the rest. */
function importsOf(file: Evidence) {
  const name = file.filename?.toLowerCase() ?? '';
  const type = file.mediaType.toLowerCase();
  if (/\.(pdf|png|jpe?g|heic|webp|tiff?)$/.test(name) || /pdf|image/.test(type)) return [];
  if (name.endsWith('.xml') || type.includes('xml')) return ['invoice', 'bank', 'rates'] as const;
  return ['bank'] as const;
}

const shownFiles = 8;

/** The files kept, newest first, each with the imports it can go through. */
function Files() {
  const { company, can, evidence, invoke, act, year } = useWorkspace();
  const [shown, setShown] = useState(shownFiles);
  const [busy, setBusy] = useState(false);
  const files = useMemo(() => [...evidence].reverse(), [evidence]);
  if (!files.length) return null;
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    await act(action, success);
    setBusy(false);
  };
  const actions = {
    invoice: {
      label: 'Factură e-Factura',
      allowed: can('invoices.import'),
      run: (file: Evidence) =>
        run(
          () => invoke('invoices.import', { evidenceId: file.id }),
          'Documentul e-Factura a fost importat.',
        ),
    },
    bank: {
      label: 'Extras bancar',
      allowed: can('bank.import') && Boolean(year),
      run: (file: Evidence) =>
        run(
          () => invoke('bank.import', { evidenceId: file.id, financialYearId: year?.id }),
          'Extrasul a fost importat.',
        ),
    },
    rates: {
      label: 'Cursuri BNR',
      allowed: can('fx.importBnr'),
      run: (file: Evidence) =>
        run(
          () => invoke('fx.importBnr', { evidenceId: file.id }),
          'Cursurile BNR au fost importate.',
        ),
    },
  };
  return (
    <section className="acc-documents-section" aria-labelledby="acc-files-heading">
      <h2 id="acc-files-heading">Fișiere păstrate</h2>
      <div className="acc-ledger-frame">
        <table className="acc-ledger-table acc-files-table">
          <thead>
            <tr>
              <th scope="col">Fișier</th>
              <th scope="col">Importă ca</th>
            </tr>
          </thead>
          <tbody>
            {files.slice(0, shown).map((file) => (
              <tr key={file.id}>
                <td data-label="Fișier">
                  {file.filename ? (
                    <a
                      href={`${companyPath(company.id)}/evidence/${encodeURIComponent(file.id)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {file.filename}
                    </a>
                  ) : (
                    <span className="acc-hint">Fișier cu acces restricționat</span>
                  )}
                </td>
                <td data-label="Importă ca">
                  <div className="acc-row-actions">
                    {file.filename
                      ? importsOf(file).map((kind) =>
                          actions[kind].allowed ? (
                            <Button
                              key={kind}
                              size="small"
                              isDisabled={busy}
                              onPress={() => void actions[kind].run(file)}
                            >
                              {actions[kind].label}
                            </Button>
                          ) : null,
                        )
                      : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {files.length > shown ? (
        <Button variant="quiet" onPress={() => setShown((count) => count + 20)}>
          Mai multe fișiere
        </Button>
      ) : null}
    </section>
  );
}

type Loaded = {
  key: string;
  items: DocumentItem[];
  next: string | null;
  loading: boolean;
  error: string;
};

/** The engine's documents, by date, filtered and read a page at a time. */
function DocumentList() {
  const { invoke, version } = useWorkspace();
  const { params, filter } = useAccountingNavigation();
  const month = isoMonth.test(params.get('documentMonth') ?? '')
    ? params.get('documentMonth')
    : null;
  const from = month ? `${month}-01` : null;
  const to = month ? lastDay(month) : null;
  const booked = bookedChoices.some((choice) => choice.id === params.get('documentBooked'))
    ? params.get('documentBooked')!
    : 'all';
  const kind = Object.hasOwn(kindLabels, params.get('documentKind') ?? '')
    ? params.get('documentKind')!
    : 'all';
  const filters = JSON.stringify([month, booked, kind]);
  // How many documents the list reads: a refresh reads as many again, so rows opened stay.
  const [sized, setSized] = useState({ filters, size: pageSize });
  const size = sized.filters === filters ? sized.size : pageSize;
  const query = useMemo(
    () => ({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(booked !== 'all' ? { booked } : {}),
      ...(kind !== 'all' ? { kinds: [kind] } : {}),
      limit: size,
    }),
    [from, to, booked, kind, size],
  );
  const key = `${filters}|${size}|${version}`;
  // The chart is read once for every booking the list may open.
  const { accounts } = useAccounts();
  const [state, setState] = useState<Loaded | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    invoke<List<DocumentItem>>('documents.list', query)
      .then((page) => {
        if (active)
          setState({ key, items: page.items, next: page.next, loading: false, error: '' });
      })
      .catch((reason: unknown) => {
        if (active)
          setState({
            key,
            items: [],
            next: null,
            loading: false,
            error: reason instanceof Error ? reason.message : 'Documentele nu au putut fi citite.',
          });
      });
    return () => {
      active = false;
    };
  }, [invoke, key, query]);
  const current = state?.key === key ? state : null;
  // A refresh keeps the rows on screen until the new page arrives.
  const shown = current ?? (state?.key.startsWith(`${filters}|`) ? state : null);
  const more = () => {
    if (!current?.next) return;
    if (size < maxPage) return setSized({ filters, size: Math.min(size + pageSize, maxPage) });
    setState({ ...current, loading: true });
    invoke<List<DocumentItem>>('documents.list', { ...query, after: current.next })
      .then((page) =>
        setState((previous) =>
          previous?.key === key
            ? {
                ...previous,
                items: [...previous.items, ...page.items],
                next: page.next,
                loading: false,
              }
            : previous,
        ),
      )
      .catch((reason: unknown) =>
        setState((previous) =>
          previous?.key === key
            ? {
                ...previous,
                loading: false,
                error:
                  reason instanceof Error ? reason.message : 'Documentele nu au putut fi citite.',
              }
            : previous,
        ),
      );
  };
  const filtered = Boolean(month || booked !== 'all' || kind !== 'all');
  return (
    <section className="acc-documents-section" aria-labelledby="acc-documents-heading">
      <h2 id="acc-documents-heading">Documente</h2>
      <div className="acc-filters">
        <MonthField
          label="Luna"
          value={month}
          placeholder="Toate lunile"
          clearLabel="Toate lunile"
          onChange={(chosen) => filter({ documentMonth: chosen })}
        />
        <Select
          label="Înregistrare"
          options={bookedChoices}
          value={booked}
          onChange={(choice) => filter({ documentBooked: choice === 'all' ? null : choice })}
        />
        <Select
          label="Tip"
          options={kindChoices}
          value={kind}
          onChange={(choice) => filter({ documentKind: choice === 'all' ? null : choice })}
        />
      </div>
      {shown?.error ? (
        <p role="alert" className="acc-error">
          {shown.error}
        </p>
      ) : null}
      {!shown ? (
        <p className="acc-hint" aria-busy="true">
          Se încarcă documentele…
        </p>
      ) : shown.items.length === 0 && !shown.error ? (
        filtered ? (
          <EmptyState
            message="Niciun document pentru filtrele alese."
            action={{
              label: 'Arată toate documentele',
              onPress: () =>
                filter({
                  documentMonth: null,
                  documentBooked: null,
                  documentKind: null,
                }),
            }}
          />
        ) : (
          <p className="acc-empty">Nu există documente importate.</p>
        )
      ) : (
        <div className="acc-ledger-frame">
          <table className="acc-ledger-table acc-documents-table">
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Tip</th>
                <th scope="col">Număr</th>
                <th scope="col">Partener</th>
                <th scope="col" className="acc-numeric">
                  Sumă
                </th>
                <th scope="col">Înregistrare</th>
              </tr>
            </thead>
            <tbody>
              {shown.items.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  accounts={accounts}
                  open={open === document.id && !document.booked}
                  toggle={() => setOpen((id) => (id === document.id ? null : document.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {current?.next ? (
        <Button variant="quiet" isDisabled={current.loading} onPress={more}>
          {current.loading ? 'Se încarcă…' : 'Mai multe documente'}
        </Button>
      ) : null}
    </section>
  );
}

function DocumentRow({
  document,
  accounts,
  open,
  toggle,
}: {
  document: DocumentItem;
  accounts: Account[] | null;
  open: boolean;
  toggle: () => void;
}) {
  const { can } = useWorkspace();
  const { href } = useAccountingNavigation();
  const treatment = bookings[document.kind];
  const bookable = Boolean(treatment) && can(`${treatment}.propose`);
  const label = kindLabels[document.kind] ?? 'Document';
  const name = [label, document.number].filter(Boolean).join(' ');
  return (
    <>
      <tr data-document={document.id}>
        <td data-label="Data" className="acc-nowrap">
          {formatDate(document.date)}
        </td>
        <td data-label="Tip">{label}</td>
        <td data-label="Număr">{document.number}</td>
        <td data-label="Partener">{document.party?.name}</td>
        <td data-label="Sumă" className="acc-numeric">
          {document.totals ? formatMoney(document.totals.gross, document.currency ?? 'RON') : null}
        </td>
        <td data-label="Înregistrare">
          <div className="acc-row-actions">
            {document.booked ? (
              <>
                <Chip tone="success">Înregistrat</Chip>
                {document.entryId ? (
                  <a
                    href={href('registers', {
                      register: 'jurnal',
                      registerEntry: document.entryId,
                      registerEntryDate: null,
                      entry: null,
                    })}
                    onClick={followLink}
                    aria-label={`Deschide nota contabilă a documentului ${name}`}
                  >
                    Nota contabilă
                  </a>
                ) : null}
              </>
            ) : bookable ? (
              <Button
                size="small"
                variant={open ? 'quiet' : 'secondary'}
                aria-expanded={open}
                aria-label={open ? `Închide înregistrarea ${name}` : `Înregistrează ${name}`}
                onPress={toggle}
              >
                {open ? 'Închide' : 'Înregistrează'}
              </Button>
            ) : (
              <Chip>Neînregistrat</Chip>
            )}
          </div>
        </td>
      </tr>
      {open && treatment ? (
        <tr className="acc-ledger-detail">
          <td colSpan={6}>
            <DocumentBooking
              document={document}
              treatment={treatment}
              name={name}
              accounts={accounts}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The booking of an invoice or a credit note: the account it goes to (and, for a purchase, the VAT
 * deduction; for a credit note, its original invoice). The proposal it becomes is reviewed here.
 */
function DocumentBooking({
  document,
  treatment,
  name,
  accounts,
}: {
  document: DocumentItem;
  treatment: 'invoices.recognize' | 'invoices.credit';
  name: string;
  accounts: Account[] | null;
}) {
  const { invoke, act } = useWorkspace();
  const sale = document.kind.endsWith('.issued');
  const credit = treatment === 'invoices.credit';
  const [account, setAccount] = useState<string | null>(null);
  const [deduction, setDeduction] = useState('full');
  const [original, setOriginal] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accountChoices = useMemo(
    () =>
      accountOptions(
        accounts,
        (candidate) =>
          !isVatAccount(candidate) &&
          (sale ? /^7/.test(candidate.code) : /^(6|2[01])/.test(candidate.code)),
        document.date,
      ),
    [accounts, sale, document.date],
  );
  const originals = useAccountingData<List<DocumentItem>>(
    'documents.list',
    { kinds: [sale ? 'invoice.issued' : 'invoice.received'] },
    credit,
  );
  const originalChoices = useMemo<ComboOption[]>(
    () =>
      (originals.data?.items ?? [])
        .filter((candidate) => !document.partyId || candidate.partyId === document.partyId)
        .map((candidate) => ({
          id: candidate.id,
          code: candidate.number ?? undefined,
          name: [
            formatDate(candidate.date),
            candidate.totals
              ? formatMoney(candidate.totals.gross, candidate.currency ?? 'RON')
              : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
        })),
    [originals.data, document.partyId],
  );
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account) return setProblem('Alege contul.');
    if (credit && !original) return setProblem('Alege factura inițială.');
    setProblem('');
    setBusy(true);
    const made: { proposal?: ProposalView } = {};
    await act(
      async () => {
        made.proposal = await invoke<ProposalView>(`${treatment}.propose`, {
          documentId: document.id,
          account,
          ...(sale ? {} : { deduction }),
          ...(credit ? { originalDocumentId: original } : {}),
        });
      },
      'Propunerea a fost pregătită pentru verificare.',
      (reason) => {
        // A proposal already holds the document: it is the one to review.
        const held =
          reason instanceof ApiError &&
          reason.code === 'SUBJECT_EXISTS' &&
          reason.details &&
          typeof reason.details === 'object'
            ? (reason.details as { proposalId?: unknown }).proposalId
            : undefined;
        if (typeof held === 'string') setProposalId(held);
        else setProblem(reason instanceof Error ? reason.message : 'Propunerea nu a reușit.');
      },
    );
    if (made.proposal) setProposalId(made.proposal.id);
    setBusy(false);
  };
  if (proposalId) return <BookingProposal id={proposalId} />;
  return (
    <form className="acc-booking" aria-label={`Înregistrarea ${name}`} onSubmit={submit}>
      <ComboBox
        label={sale ? 'Cont de venituri' : 'Cont de cheltuieli'}
        options={accountChoices}
        value={account}
        onChange={setAccount}
        placeholder="Cod sau denumire"
        emptyMessage="Niciun cont"
      />
      {sale ? null : (
        <Select
          label="Deducere TVA"
          options={[
            { id: 'full', label: 'Integrală' },
            { id: 'none', label: 'Fără deducere' },
          ]}
          value={deduction}
          onChange={(choice) => choice && setDeduction(choice)}
        />
      )}
      {credit ? (
        <ComboBox
          label="Factura inițială"
          options={originalChoices}
          value={original}
          onChange={setOriginal}
          placeholder="Număr sau dată"
          emptyMessage="Nicio factură a partenerului"
        />
      ) : null}
      <Button type="submit" variant="primary" isDisabled={busy}>
        Pregătește înregistrarea
      </Button>
      {problem ? (
        <p role="alert" className="acc-error acc-booking-problem">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/** The proposal a booking became, with its approval and posting, in place. */
export function BookingProposal({ id }: { id: string }) {
  const { can } = useWorkspace();
  const read = useAccountingData<ProposalView>('proposals.get', { id }, can('proposals.get'));
  if (read.error)
    return (
      <p role="alert" className="acc-error">
        {read.error}
      </p>
    );
  if (!read.data)
    return (
      <p className="acc-hint" aria-busy="true">
        Se încarcă propunerea…
      </p>
    );
  return <ProposalCard key={`${read.data.id}:${read.data.version}`} proposal={read.data} />;
}
