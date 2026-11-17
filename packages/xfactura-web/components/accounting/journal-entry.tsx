'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { FileTrigger } from 'react-aria-components';
import type { ProposalView } from 'xfactura-api/contracts';
import { ApiError } from './api';
import { formatMinor } from './format';
import { followLink, useAccountingNavigation } from './navigation';
import {
  accountOptions,
  isVatAccount,
  itemControlled,
  openItemOption,
  useAccounts,
  useOpenItems,
  useParties,
  type Account,
  type OpenItem,
  type Party,
} from './reference-data';
import { ProposalCard } from './review';
import {
  Button,
  ComboBox,
  DateField,
  Dialog,
  IconButton,
  MoneyField,
  Select,
  TextField,
  icons,
  type ComboOption,
} from './ui';
import { useAccountingData } from './use-data';
import { useWorkspace } from './workspace';

/** The most lines `ledger.general` takes in one entry. */
const maxLines = 2000;
/** How long typing pauses before the engine previews the entry. */
const previewDelay = 350;

type Purpose = 'general' | 'opening' | 'adjustment';
const purposes: { id: Purpose; label: string }[] = [
  { id: 'general', label: 'Generală' },
  { id: 'opening', label: 'Deschidere' },
  { id: 'adjustment', label: 'Ajustare' },
];

/** The open item a line on a control account settles, or the new invoice it opens. */
type Item =
  | { mode: 'existing'; openItem: string | null }
  | { mode: 'new'; number: string; dueDate: string | null };
type Line = {
  id: string;
  account: string | null;
  debit: string | null;
  credit: string | null;
  memo: string;
  partyId: string | null;
  item: Item;
  /** Bumped to empty an amount field when the other side is typed. */
  debitKey: number;
  creditKey: number;
};
type Draft = {
  date: string | null;
  purpose: Purpose;
  reference: string;
  description: string;
  evidenceId: string | null;
  lines: Line[];
};

type Issue = {
  code: string;
  severity: 'block' | 'ack' | 'info';
  message: string;
  path?: string;
  details?: unknown;
};
type Totals = { currency: string; debit: string; credit: string; difference: string };
type Preview = { issues: Issue[]; blocking: boolean; totals: Totals[] | null };

type Cell = 'account' | 'party' | 'item' | 'amount' | 'memo';
type HeaderField = 'date' | 'purpose' | 'reference' | 'description' | 'evidenceId';

let lineCounter = 0;
const newLine = (): Line => ({
  id: `line-${Date.now().toString(36)}-${(lineCounter += 1)}`,
  account: null,
  debit: null,
  credit: null,
  memo: '',
  partyId: null,
  item: { mode: 'existing', openItem: null },
  debitKey: 0,
  creditKey: 0,
});

const bucharestDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in Romania, held to the financial year shown. */
function defaultDate(year: { from: string; to: string } | undefined) {
  const today = bucharestDay.format(new Date());
  if (!year) return today;
  return today < year.from ? year.from : today > year.to ? year.to : today;
}

const emptyDraft = (date: string | null): Draft => ({
  date,
  purpose: 'general',
  reference: '',
  description: '',
  evidenceId: null,
  lines: [newLine(), newLine()],
});

const draftKey = (companyId: string) => `xfactura.accounting.journal-entry.${companyId}`;

function readDraft(companyId: string): Draft | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(draftKey(companyId));
    const draft = stored ? (JSON.parse(stored) as Draft) : null;
    return draft && Array.isArray(draft.lines) && draft.lines.length > 0 ? draft : null;
  } catch {
    return null;
  }
}

/** A new invoice's reference in the entry, from its number: what `newItems[].ref` accepts. */
function referenceOf(number: string) {
  const slug = number
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 36)
    .replace(/-+$/, '');
  return slug || 'factura';
}

const hasContent = (line: Line) =>
  Boolean(line.account || line.debit || line.credit || line.memo.trim() || line.partyId);

type Built = {
  input: Record<string, unknown>;
  /** The line shown for each line of the input, in order. */
  rows: string[];
  /** The lines that use each new invoice reference. */
  refs: Record<string, string[]>;
  /** What is still missing before the engine can evaluate the entry, in words. */
  missing: string[];
  /** The same, per field and per line cell. */
  gaps: {
    header: Partial<Record<HeaderField, string>>;
    lines: Record<string, Partial<Record<Cell, string>>>;
  };
};

/** The input `ledger.general` receives, from what the person typed; nothing is computed here. */
function build(draft: Draft, accounts: Map<string, Account>): Built {
  const missing: string[] = [];
  const gaps: Built['gaps'] = { header: {}, lines: {} };
  const need = (field: HeaderField, words: string, message: string) => {
    missing.push(words);
    gaps.header[field] = message;
  };
  if (!draft.date) need('date', 'data', 'Completează data.');
  if (!draft.reference.trim()) need('reference', 'referința', 'Completează referința.');
  if (draft.description.trim().length < 3)
    need('description', 'explicația', 'Scrie o explicație de cel puțin 3 caractere.');
  if (!draft.evidenceId)
    need('evidenceId', 'documentul justificativ', 'Alege sau încarcă documentul justificativ.');

  const written = draft.lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => hasContent(line));
  if (written.length < 2) missing.push('cel puțin două linii');

  const refs: Record<string, string[]> = {};
  const owners = new Map<string, string>();
  const newItems: Record<string, unknown>[] = [];
  const lines = written.map(({ line, number }) => {
    const gap: Partial<Record<Cell, string>> = {};
    const account = line.account ? accounts.get(line.account) : undefined;
    const controlled = itemControlled(account?.controlKind ?? null);
    if (!line.account) gap.account = 'Alege contul.';
    if (!line.debit && !line.credit) gap.amount = 'Completează suma la debit sau la credit.';
    if (controlled && !line.partyId) gap.party = 'Alege partenerul.';
    if (controlled && line.partyId) {
      if (line.item.mode === 'existing' && !line.item.openItem) gap.item = 'Alege factura.';
      if (line.item.mode === 'new' && !line.item.number.trim())
        gap.item = 'Completează numărul facturii.';
    }
    if (Object.keys(gap).length) {
      gaps.lines[line.id] = gap;
      missing.push(`linia ${number}`);
    }
    let newItem: string | undefined;
    if (controlled && line.partyId && line.item.mode === 'new' && line.item.number.trim()) {
      // One reference per invoice: the same number, partner and account is the same invoice.
      const owner = `${line.partyId}|${line.account}|${line.item.number.trim()}`;
      const base = referenceOf(line.item.number);
      let ref = base;
      for (let suffix = 2; owners.has(ref) && owners.get(ref) !== owner; suffix += 1)
        ref = `${base}-${suffix}`;
      if (!owners.has(ref)) {
        owners.set(ref, owner);
        newItems.push({
          ref,
          partyId: line.partyId,
          ...(line.item.dueDate ? { dueDate: line.item.dueDate } : {}),
        });
      }
      refs[ref] = [...(refs[ref] ?? []), line.id];
      newItem = ref;
    }
    const memo = line.memo.trim();
    return {
      account: line.account ?? '',
      side: line.debit ? 'D' : 'C',
      amount: line.debit ?? line.credit ?? '',
      ...(controlled && line.partyId ? { partyId: line.partyId } : {}),
      ...(controlled && line.item.mode === 'existing' && line.item.openItem
        ? { openItem: line.item.openItem }
        : {}),
      ...(newItem ? { newItem } : {}),
      ...(memo ? { memo } : {}),
    };
  });
  return {
    input: {
      date: draft.date ?? '',
      purpose: draft.purpose,
      reference: draft.reference.trim(),
      description: draft.description.trim(),
      evidenceId: draft.evidenceId ?? '',
      lines,
      ...(newItems.length ? { newItems } : {}),
    },
    rows: written.map(({ line }) => line.id),
    refs,
    missing,
    gaps,
  };
}

/** Where the engine's issues belong: a header field, a line's cell, the totals, or the entry. */
type Placed = {
  header: Partial<Record<HeaderField, Issue[]>>;
  lines: Record<string, { issues: Issue[]; cells: Cell[] }>;
  totals: Issue[];
  general: Issue[];
};

const cellOfCode: Record<string, Cell> = {
  ACCOUNT_UNKNOWN: 'account',
  ACCOUNT_NOT_POSTABLE: 'account',
  ACCOUNT_DATE: 'account',
  RETAIL_ACCOUNT: 'account',
  NOT_CONTROL_ACCOUNT: 'account',
  OPEN_ITEM_NOT_CONTROL: 'account',
  TAX_LINE_UNEXPLAINED: 'account',
  LINE_ZERO: 'amount',
  LINE_RANGE: 'amount',
  LINE_CURRENCY_SIGN: 'amount',
  CONTROL_OPEN_ITEM: 'item',
  OPEN_ITEM_UNKNOWN: 'item',
  OPEN_ITEM_ACCOUNT: 'item',
  OPEN_ITEM_CURRENCY: 'item',
  NEW_ITEM: 'item',
  OPEN_ITEM_PARTY: 'party',
  PARTY: 'party',
};
const cellOfField: Record<string, Cell> = {
  account: 'account',
  amount: 'amount',
  side: 'amount',
  memo: 'memo',
  partyId: 'party',
  openItem: 'item',
  newItem: 'item',
};
const headerFields = new Set<string>(['date', 'purpose', 'reference', 'description', 'evidenceId']);

function place(issues: Issue[], built: Built, draft: Draft): Placed {
  const placed: Placed = { header: {}, lines: {}, totals: [], general: [] };
  const atLine = (lineId: string, issue: Issue, cell: Cell | undefined) => {
    const entry = (placed.lines[lineId] ??= { issues: [], cells: [] });
    if (!entry.issues.includes(issue)) entry.issues.push(issue);
    if (cell && !entry.cells.includes(cell)) entry.cells.push(cell);
  };
  for (const issue of issues) {
    const path = issue.path ?? '';
    const [root, index, field] = path.split('.');
    if (root && headerFields.has(root)) {
      (placed.header[root as HeaderField] ??= []).push(issue);
      continue;
    }
    if (root === 'lines' && index !== undefined && /^\d+$/.test(index)) {
      const lineId = built.rows[Number(index)];
      if (lineId) {
        atLine(lineId, issue, (field && cellOfField[field]) || cellOfCode[issue.code]);
        continue;
      }
    }
    if (root === 'lines') {
      placed.totals.push(issue);
      continue;
    }
    if (root === 'newItems' && index !== undefined) {
      const ref = (built.input.newItems as { ref: string }[] | undefined)?.[Number(index)]?.ref;
      const lineIds = ref ? built.refs[ref] : undefined;
      if (lineIds?.length) {
        for (const lineId of lineIds) atLine(lineId, issue, field === 'partyId' ? 'party' : 'item');
        continue;
      }
    }
    // An open item's balance runs past zero: the lines that name it.
    const named =
      issue.details && typeof issue.details === 'object' && 'openItem' in issue.details
        ? String((issue.details as { openItem: unknown }).openItem)
        : null;
    const lineIds = named
      ? draft.lines
          .filter(
            (line) =>
              (line.item.mode === 'existing' && line.item.openItem === named) ||
              built.refs[named]?.includes(line.id),
          )
          .map((line) => line.id)
      : [];
    if (lineIds.length) for (const lineId of lineIds) atLine(lineId, issue, 'item');
    else placed.general.push(issue);
  }
  return placed;
}

/** A refusal of the input before it was evaluated, as issues placed where they belong. */
function refusalIssues(reason: unknown): Issue[] {
  if (reason instanceof ApiError && reason.code === 'VALIDATION' && Array.isArray(reason.details))
    return reason.details.flatMap((detail: unknown) => {
      if (!detail || typeof detail !== 'object') return [];
      const path = String((detail as { path?: unknown }).path ?? '');
      return [
        {
          code: 'VALIDATION',
          severity: 'block' as const,
          path,
          message: /amount$/.test(path) ? 'Suma nu este acceptată.' : 'Valoarea nu este acceptată.',
        },
      ];
    });
  if (reason instanceof ApiError && reason.code === 'SUBJECT_EXISTS')
    return [{ code: reason.code, severity: 'block', path: 'reference', message: reason.message }];
  return [
    {
      code: reason instanceof ApiError ? (reason.code ?? 'ERROR') : 'ERROR',
      severity: 'block',
      message: reason instanceof Error ? reason.message : 'Nota nu a putut fi evaluată.',
    },
  ];
}

/**
 * Registrul jurnal's own work: a journal entry being written (`entry=new`) or the proposal it
 * became (`entry=<proposal id>`), so either can be linked to and survives a reload.
 */
export default function JournalEntryView({ entry }: { entry: string }) {
  const { can } = useWorkspace();
  if (entry !== 'new') return <JournalProposal id={entry} />;
  if (!can('ledger.general.propose'))
    return <p className="acc-empty">Rolul dumneavoastră nu poate pregăti note contabile.</p>;
  return <JournalEntryForm />;
}

function JournalProposal({ id }: { id: string }) {
  const { can } = useWorkspace();
  const { href, filter } = useAccountingNavigation();
  const read = useAccountingData<ProposalView>('proposals.get', { id }, can('proposals.get'));
  const proposal = read.data;
  const posted = proposal?.entry ?? null;
  return (
    <section className="acc-entry" aria-label="Propunerea notei contabile">
      <div className="acc-entry-head acc-entry-head-end">
        <Button variant="quiet" onPress={() => filter({ entry: null })}>
          Înapoi la registrul jurnal
        </Button>
      </div>
      {read.error ? (
        <p role="alert" className="acc-error">
          {read.error}
        </p>
      ) : null}
      {proposal ? (
        <ProposalCard key={`${proposal.id}:${proposal.version}`} proposal={proposal} />
      ) : !read.error ? (
        <p className="acc-hint" aria-busy="true">
          Se încarcă propunerea…
        </p>
      ) : null}
      {posted ? (
        <p>
          <a
            href={href('registers', {
              entry: null,
              registerEntry: posted.id,
              registerEntryDate: proposal?.effect?.date ?? null,
            })}
            onClick={followLink}
          >
            Deschide înregistrarea {posted.number}
          </a>
        </p>
      ) : null}
    </section>
  );
}

function JournalEntryForm() {
  const { company, year, evidence, invoke, act, upload } = useWorkspace();
  const { href, filter } = useAccountingNavigation();
  const { accounts, byCode } = useAccounts();
  const { parties } = useParties();
  const { items: openItems } = useOpenItems();
  const [draft, setDraftState] = useState<Draft>(
    () => readDraft(company.id) ?? emptyDraft(defaultDate(year)),
  );
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string[]>([]);
  // A refusal concerns the entry as it was submitted; any change answers it.
  const setDraft = (change: (current: Draft) => Draft) => {
    setRefusal([]);
    setDraftState(change);
  };
  const [focusLine, setFocusLine] = useState<string | null>(null);
  const [vatTyped, setVatTyped] = useState<Record<string, string>>({});
  const [newParty, setNewParty] = useState<string | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const headingId = useId();

  // The draft survives a reload of the same address, until it is proposed or abandoned.
  useEffect(() => {
    window.sessionStorage.setItem(draftKey(company.id), JSON.stringify(draft));
  }, [company.id, draft]);
  const forget = () => window.sessionStorage.removeItem(draftKey(company.id));

  const update = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  const updateLine = (id: string, change: (line: Line) => Line) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === id ? change(line) : line)),
    }));

  const built = useMemo(() => build(draft, byCode), [draft, byCode]);
  const ready = built.missing.length === 0;
  const payload = ready ? JSON.stringify(built.input) : null;

  const [preview, setPreview] = useState<{
    payload: string;
    result?: Preview;
    issues: Issue[];
  } | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    if (!payload) return;
    const request = ++sequence.current;
    const timer = window.setTimeout(() => {
      invoke<Preview>('proposals.preview', {
        treatment: 'ledger.general',
        input: JSON.parse(payload),
      })
        .then((result) => {
          if (sequence.current === request) setPreview({ payload, result, issues: result.issues });
        })
        .catch((reason: unknown) => {
          if (sequence.current === request) setPreview({ payload, issues: refusalIssues(reason) });
        });
    }, previewDelay);
    return () => window.clearTimeout(timer);
  }, [payload, invoke]);
  const current = preview && payload && preview.payload === payload ? preview : null;
  const evaluating = Boolean(payload) && !current;
  const placed = place(current?.issues ?? [], built, draft);

  const accountChoices = useMemo(
    () => accountOptions(accounts, (account) => !isVatAccount(account), draft.date),
    [accounts, draft.date],
  );
  const partyChoices = useMemo<ComboOption[]>(
    () =>
      (parties ?? []).map((party) => ({
        id: party.id,
        // The name first, as the field shows it; the identifier too, so either finds it.
        name: party.taxId ? `${party.name} · ${party.taxId}` : party.name,
      })),
    [parties],
  );
  const evidenceChoices = useMemo<ComboOption[]>(
    () => evidence.flatMap((file) => (file.filename ? [{ id: file.id, name: file.filename }] : [])),
    [evidence],
  );
  const controlled = (line: Line) =>
    itemControlled((line.account && byCode.get(line.account)?.controlKind) || null);
  const anyControlled = draft.lines.some(controlled);
  const columns = anyControlled ? 8 : 6;

  useEffect(() => {
    if (!focusLine) return;
    table.current
      ?.querySelector<HTMLInputElement>(`tr[data-line="${focusLine}"] .acc-entry-account input`)
      ?.focus();
    setFocusLine(null);
  }, [focusLine, draft.lines]);

  const addLine = (after?: string) => {
    if (draft.lines.length >= maxLines) return;
    const line = newLine();
    setDraft((current) => {
      const at = after ? current.lines.findIndex((other) => other.id === after) + 1 : 0;
      const lines = [...current.lines];
      lines.splice(at > 0 ? at : lines.length, 0, line);
      return { ...current, lines };
    });
    setFocusLine(line.id);
  };
  const removeLine = (id: string) =>
    setDraft((current) => ({
      ...current,
      // An entry keeps two lines on screen: removing one of the last two empties it instead.
      lines:
        current.lines.length > 2
          ? current.lines.filter((line) => line.id !== id)
          : current.lines.map((line) =>
              line.id === id
                ? { ...newLine(), debitKey: line.debitKey + 1, creditKey: line.creditKey + 1 }
                : line,
            ),
    }));

  /** Enter in a line's explanation goes to the next line's account, adding one after the last. */
  const onMemoKey = (event: KeyboardEvent, line: Line) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const index = draft.lines.findIndex((other) => other.id === line.id);
    const next = draft.lines[index + 1];
    if (next) setFocusLine(next.id);
    else addLine(line.id);
  };

  const uploadEvidence = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const kept: { id?: string } = {};
    await act(async () => {
      kept.id = (await upload(file)).id;
    }, `${file.name} a fost păstrat.`);
    if (kept.id) update({ evidenceId: kept.id });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    setRefusal([]);
    if (!ready) {
      setRefusal([`Completează ${built.missing.join(', ')}.`]);
      return;
    }
    setBusy(true);
    const input = built.input;
    const shown = JSON.stringify(input);
    try {
      // The entry is proposed only as the engine evaluates it now, and only without a blocking issue.
      const result = await invoke<Preview>('proposals.preview', {
        treatment: 'ledger.general',
        input,
      });
      setPreview({ payload: shown, result, issues: result.issues });
      if (result.blocking) {
        setRefusal(
          result.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.message),
        );
        return;
      }
      const made: { proposal?: ProposalView } = {};
      const done = await act(
        async () => {
          made.proposal = await invoke<ProposalView>('ledger.general.propose', input);
        },
        'Propunerea a fost pregătită pentru verificare.',
        (reason) =>
          setRefusal([reason instanceof Error ? reason.message : 'Propunerea nu a reușit.']),
      );
      if (done && made.proposal) {
        forget();
        filter({ entry: made.proposal.id });
      }
    } catch (reason) {
      const issues = refusalIssues(reason);
      setPreview({ payload: shown, issues });
      setRefusal(issues.map((issue) => issue.message));
    } finally {
      setBusy(false);
    }
  };

  const headerProblem = (field: HeaderField) => {
    const engine = placed.header[field]?.map((issue) => issue.message).join(' ');
    return engine || (attempted ? built.gaps.header[field] : undefined);
  };
  const problemText = (field: HeaderField) => {
    const problem = headerProblem(field);
    return problem ? <span className="acc-field-error">{problem}</span> : undefined;
  };

  return (
    <form ref={form} className="acc-entry" aria-labelledby={headingId} onSubmit={submit}>
      <div className="acc-entry-head">
        <h2 id={headingId}>Notă contabilă nouă</h2>
        <Button
          variant="quiet"
          onPress={() => {
            forget();
            filter({ entry: null });
          }}
        >
          Renunță
        </Button>
      </div>

      <div className="acc-entry-header">
        {/* Uncontrolled: a day half typed stays as typed, and the form refuses it. */}
        <DateField
          label="Data"
          defaultValue={draft.date ?? undefined}
          onChange={(date) => update({ date })}
          isRequired
          description={problemText('date')}
        />
        <Select
          label="Tip"
          options={purposes}
          value={draft.purpose}
          onChange={(purpose) => purpose && update({ purpose: purpose as Purpose })}
          description={problemText('purpose')}
        />
        <TextField
          label="Referință"
          value={draft.reference}
          onChange={(reference) => update({ reference })}
          maxLength={100}
          isInvalid={Boolean(headerProblem('reference'))}
          errorMessage={headerProblem('reference')}
        />
        <TextField
          label="Explicație"
          className="acc-entry-description"
          value={draft.description}
          onChange={(description) => update({ description })}
          maxLength={1000}
          isInvalid={Boolean(headerProblem('description'))}
          errorMessage={headerProblem('description')}
        />
        <div className="acc-entry-evidence">
          <ComboBox
            label="Document justificativ"
            options={evidenceChoices}
            value={draft.evidenceId}
            onChange={(evidenceId) => update({ evidenceId })}
            placeholder="Caută după nume"
            emptyMessage="Niciun document cu acest nume"
            description={problemText('evidenceId')}
          />
          <FileTrigger onSelect={(files) => void uploadEvidence(files)}>
            <IconButton
              label="Încarcă documentul justificativ"
              icon={icons.upload}
              variant="secondary"
            />
          </FileTrigger>
        </div>
      </div>

      <div className="acc-entry-frame">
        <table ref={table} className="acc-entry-grid" data-controlled={anyControlled || undefined}>
          <caption className="acc-visually-hidden">Liniile notei; sumele în lei</caption>
          <colgroup>
            <col className="acc-entry-col-number" />
            <col className="acc-entry-col-account" />
            {anyControlled ? (
              <>
                <col className="acc-entry-col-party" />
                <col className="acc-entry-col-item" />
              </>
            ) : null}
            <col className="acc-entry-col-amount" />
            <col className="acc-entry-col-amount" />
            <col />
            <col className="acc-entry-col-remove" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <span className="acc-visually-hidden">Linia</span>
              </th>
              <th scope="col">Cont</th>
              {anyControlled ? (
                <>
                  <th scope="col">Partener</th>
                  <th scope="col">Factură</th>
                </>
              ) : null}
              <th scope="col" className="acc-numeric">
                Debit
              </th>
              <th scope="col" className="acc-numeric">
                Credit
              </th>
              <th scope="col">Explicație</th>
              <th scope="col">
                <span className="acc-visually-hidden">Elimină</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((line, index) => (
              <EntryLine
                key={line.id}
                line={line}
                number={index + 1}
                columns={columns}
                anyControlled={anyControlled}
                controlled={controlled(line)}
                accountChoices={accountChoices}
                partyChoices={partyChoices}
                openItems={openItems}
                parties={parties}
                placed={placed.lines[line.id]}
                gaps={attempted ? built.gaps.lines[line.id] : undefined}
                vatTyped={vatTyped[line.id]}
                onVatTyped={(code) =>
                  setVatTyped((typed) => {
                    const next = { ...typed };
                    if (code) next[line.id] = code;
                    else delete next[line.id];
                    return next;
                  })
                }
                documentsHref={href('documents')}
                onChange={(change) => updateLine(line.id, change)}
                onRemove={() => removeLine(line.id)}
                onMemoKey={(event) => onMemoKey(event, line)}
                onNewParty={() => setNewParty(line.id)}
              />
            ))}
          </tbody>
          <EntryTotals
            columns={columns}
            totals={current?.result?.totals ?? (evaluating ? previousTotals(preview) : null)}
            evaluating={evaluating}
            missing={ready ? [] : built.missing}
            issues={placed.totals}
          />
        </table>
      </div>

      <div className="acc-entry-foot">
        <Button
          variant="quiet"
          isDisabled={draft.lines.length >= maxLines}
          onPress={() => addLine(draft.lines.at(-1)?.id)}
        >
          {icons.plus}
          Adaugă o linie
        </Button>
        <div className="acc-entry-submit">
          {placed.general.length ? (
            <ul className="acc-entry-messages">
              {placed.general.map((issue, index) => (
                <li key={`${issue.code}:${index}`} data-severity={issue.severity}>
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          {refusal.length ? (
            <div role="alert" className="acc-entry-refusal">
              {refusal.map((message, index) => (
                <p key={index}>{message}</p>
              ))}
            </div>
          ) : null}
          <Button variant="primary" isDisabled={busy} onPress={() => form.current?.requestSubmit()}>
            Pregătește înregistrarea
          </Button>
        </div>
      </div>
      {newParty ? (
        <PartyDialog
          onClose={() => setNewParty(null)}
          onChosen={(partyId) => {
            const lineId = newParty;
            setNewParty(null);
            updateLine(lineId, (line) => ({
              ...line,
              partyId,
              item: { mode: 'new', number: '', dueDate: null },
            }));
          }}
        />
      ) : null}
    </form>
  );
}

/** The totals last shown, kept dimmed while the engine evaluates the entry as changed. */
function previousTotals(preview: { result?: Preview } | null) {
  return preview?.result?.totals ?? null;
}

function EntryTotals({
  columns,
  totals,
  evaluating,
  missing,
  issues,
}: {
  columns: number;
  totals: Totals[] | null;
  evaluating: boolean;
  missing: string[];
  issues: Issue[];
}) {
  const lead = columns - 4;
  const rows = totals?.length ? totals : [null];
  return (
    <tfoot aria-busy={evaluating || undefined} data-stale={evaluating && totals ? true : undefined}>
      {rows.map((total, index) => {
        const balanced = total ? /^-?0+$/.test(total.difference) : false;
        return (
          <tr key={total?.currency ?? index} className="acc-entry-total">
            <th scope="row" colSpan={lead}>
              Total{total ? ` ${total.currency}` : ''}
            </th>
            <td className="acc-numeric" data-label="Debit">
              {total ? (
                <span className="acc-entry-sum">
                  {formatMinor(total.debit, total.currency, { suffix: false })}
                </span>
              ) : (
                '—'
              )}
            </td>
            <td className="acc-numeric" data-label="Credit">
              {total ? (
                <span className="acc-entry-sum">
                  {formatMinor(total.credit, total.currency, { suffix: false })}
                </span>
              ) : (
                '—'
              )}
            </td>
            <td
              colSpan={2}
              className="acc-entry-difference"
              data-state={total ? (balanced ? 'balanced' : 'unbalanced') : undefined}
            >
              <span className="acc-entry-difference-value">
                Diferență{' '}
                <strong>{total ? formatMinor(total.difference, total.currency) : '—'}</strong>
                {balanced ? icons.check : null}
              </span>
            </td>
          </tr>
        );
      })}
      {missing.length || issues.length ? (
        <tr className="acc-entry-total-note">
          <td colSpan={columns}>
            {missing.length ? (
              <p className="acc-hint">
                Totalurile apar după ce completezi {missing.slice(0, 4).join(', ')}
                {missing.length > 4 ? ' și celelalte' : ''}.
              </p>
            ) : null}
            {issues.map((issue, index) => (
              <p
                key={`${issue.code}:${index}`}
                className="acc-entry-issue"
                data-severity={issue.severity}
              >
                {issue.message}
              </p>
            ))}
          </td>
        </tr>
      ) : null}
    </tfoot>
  );
}

function EntryLine({
  line,
  number,
  columns,
  anyControlled,
  controlled,
  accountChoices,
  partyChoices,
  openItems,
  parties,
  placed,
  gaps,
  vatTyped,
  onVatTyped,
  documentsHref,
  onChange,
  onRemove,
  onMemoKey,
  onNewParty,
}: {
  line: Line;
  number: number;
  columns: number;
  anyControlled: boolean;
  controlled: boolean;
  accountChoices: ComboOption[];
  partyChoices: ComboOption[];
  openItems: OpenItem[] | null;
  parties: Party[] | null;
  placed: { issues: Issue[]; cells: Cell[] } | undefined;
  gaps: Partial<Record<Cell, string>> | undefined;
  vatTyped: string | undefined;
  onVatTyped: (code: string | null) => void;
  documentsHref: string;
  onChange: (change: (line: Line) => Line) => void;
  onRemove: () => void;
  onMemoKey: (event: KeyboardEvent) => void;
  onNewParty: () => void;
}) {
  const invalid = (cell: Cell) =>
    placed?.cells.includes(cell) || Boolean(gaps?.[cell]) || undefined;
  const items = useMemo(
    () =>
      (openItems ?? []).filter(
        (item) => item.partyId === line.partyId && item.account === line.account,
      ),
    [openItems, line.partyId, line.account],
  );
  const itemChoices = useMemo(() => items.map((item) => openItemOption(item)), [items]);
  const partyName = parties?.find((party) => party.id === line.partyId)?.name;
  const messages = [
    ...Object.values(gaps ?? {}).map((message) => ({ message, severity: 'block' })),
    ...(placed?.issues ?? []).map((issue) => ({
      message: issue.message,
      severity: issue.severity,
    })),
  ];
  const label = (name: string) => `${name}, linia ${number}`;
  return (
    <>
      <tr className="acc-entry-line" data-line={line.id}>
        <td className="acc-entry-number">
          <span className="acc-entry-number-word">Linia </span>
          {number}
        </td>
        <td className="acc-entry-account" data-invalid={invalid('account')}>
          <ComboBox
            label={label('Cont')}
            className="acc-cell-field"
            options={accountChoices}
            value={line.account}
            onChange={(account) => {
              onVatTyped(null);
              onChange((current) =>
                current.account === account
                  ? current
                  : {
                      ...current,
                      account,
                      // Another account names its own partner and invoice.
                      item: { mode: 'existing', openItem: null },
                    },
              );
            }}
            onInputChange={(text) => {
              const vat = /^442[678]\b/.exec(text.trim());
              onVatTyped(vat ? vat[0] : null);
            }}
            placeholder="Cod sau denumire"
            emptyMessage="Niciun cont"
          />
        </td>
        {anyControlled ? (
          controlled ? (
            <>
              <td className="acc-entry-party" data-invalid={invalid('party')}>
                <div className="acc-entry-with-action">
                  <ComboBox
                    label={label('Partener')}
                    className="acc-cell-field"
                    options={partyChoices}
                    value={line.partyId}
                    onChange={(partyId) =>
                      onChange((current) =>
                        current.partyId === partyId
                          ? current
                          : {
                              ...current,
                              partyId,
                              // A partner without open invoices on the account starts a new one.
                              item: (openItems ?? []).some(
                                (item) =>
                                  item.partyId === partyId && item.account === current.account,
                              )
                                ? { mode: 'existing', openItem: null }
                                : { mode: 'new', number: '', dueDate: null },
                            },
                      )
                    }
                    placeholder="Caută partenerul"
                    emptyMessage="Niciun partener"
                  />
                  <IconButton
                    label={`Partener nou, linia ${number}`}
                    icon={icons.plus}
                    size="small"
                    onPress={onNewParty}
                  />
                </div>
              </td>
              <td className="acc-entry-item" data-invalid={invalid('item')}>
                {!line.partyId ? (
                  <p className="acc-entry-cell-hint">Alege întâi partenerul</p>
                ) : line.item.mode === 'existing' ? (
                  <div className="acc-entry-with-action">
                    <ComboBox
                      label={label('Factură')}
                      className="acc-cell-field"
                      options={itemChoices}
                      value={line.item.openItem}
                      onChange={(openItem) =>
                        onChange((current) => ({
                          ...current,
                          item: { mode: 'existing', openItem },
                        }))
                      }
                      placeholder={items.length ? 'Caută factura' : 'Nicio factură deschisă'}
                      emptyMessage="Nicio factură deschisă"
                    />
                    <IconButton
                      label={`Factură nouă, linia ${number}`}
                      icon={icons.plus}
                      size="small"
                      onPress={() =>
                        onChange((current) => ({
                          ...current,
                          item: { mode: 'new', number: '', dueDate: null },
                        }))
                      }
                    />
                  </div>
                ) : (
                  <div className="acc-entry-new-item">
                    <TextField
                      label={label('Număr factură nouă')}
                      className="acc-cell-field"
                      value={line.item.number}
                      placeholder="Număr factură"
                      maxLength={100}
                      onChange={(value) =>
                        onChange((current) =>
                          current.item.mode === 'new'
                            ? { ...current, item: { ...current.item, number: value } }
                            : current,
                        )
                      }
                    />
                    <DateField
                      label={label('Scadență')}
                      description="Scadența"
                      className="acc-cell-field"
                      defaultValue={line.item.dueDate ?? undefined}
                      onChange={(dueDate) =>
                        onChange((current) =>
                          current.item.mode === 'new'
                            ? { ...current, item: { ...current.item, dueDate } }
                            : current,
                        )
                      }
                    />
                    {items.length ? (
                      <Button
                        variant="quiet"
                        size="small"
                        onPress={() =>
                          onChange((current) => ({
                            ...current,
                            item: { mode: 'existing', openItem: null },
                          }))
                        }
                      >
                        Alege o factură deschisă
                      </Button>
                    ) : null}
                  </div>
                )}
              </td>
            </>
          ) : (
            <td colSpan={2} className="acc-entry-blank" />
          )
        ) : null}
        <td className="acc-entry-amount" data-invalid={invalid('amount')}>
          <MoneyField
            key={`d${line.debitKey}`}
            label={label('Debit')}
            className="acc-cell-field"
            defaultValue={line.debit ?? undefined}
            onChange={(debit) =>
              onChange((current) =>
                debit !== null && (current.credit !== null || current.debit === null)
                  ? { ...current, debit, credit: null, creditKey: current.creditKey + 1 }
                  : { ...current, debit },
              )
            }
          />
        </td>
        <td className="acc-entry-amount" data-invalid={invalid('amount')}>
          <MoneyField
            key={`c${line.creditKey}`}
            label={label('Credit')}
            className="acc-cell-field"
            defaultValue={line.credit ?? undefined}
            onChange={(credit) =>
              onChange((current) =>
                credit !== null && (current.debit !== null || current.credit === null)
                  ? { ...current, credit, debit: null, debitKey: current.debitKey + 1 }
                  : { ...current, credit },
              )
            }
          />
        </td>
        <td className="acc-entry-memo" data-invalid={invalid('memo')}>
          <TextField
            label={label('Explicație')}
            className="acc-cell-field"
            value={line.memo}
            maxLength={500}
            onChange={(memo) => onChange((current) => ({ ...current, memo }))}
            onKeyDown={onMemoKey}
          />
        </td>
        <td className="acc-entry-remove">
          <IconButton
            label={`Elimină linia ${number}`}
            icon={icons.trash}
            size="small"
            onPress={onRemove}
          />
        </td>
      </tr>
      {vatTyped && !line.account ? (
        <tr className="acc-entry-note">
          <td colSpan={columns}>
            <p className="acc-entry-vat">
              Contul {vatTyped} nu se alege în nota contabilă: TVA se înregistrează odată cu
              factura, din{' '}
              <a
                href={documentsHref}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => followLink(event)}
              >
                Documente
              </a>
              .
            </p>
          </td>
        </tr>
      ) : null}
      {messages.length ? (
        <tr className="acc-entry-note">
          <td colSpan={columns}>
            {messages.map((item, index) => (
              <p key={index} className="acc-entry-issue" data-severity={item.severity}>
                {item.message}
              </p>
            ))}
          </td>
        </tr>
      ) : null}
      {controlled && partyName === undefined && line.partyId && parties ? (
        <tr className="acc-entry-note">
          <td colSpan={columns}>
            <p className="acc-hint">Partenerul ales nu mai este în lista partenerilor.</p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const partyKinds = [
  { id: 'ro_legal_entity', label: 'Persoană juridică din România' },
  { id: 'ro_individual_enterprise', label: 'PFA, II sau IF' },
  { id: 'ro_individual', label: 'Persoană fizică' },
  { id: 'ro_public_institution', label: 'Instituție publică' },
  { id: 'eu_taxable', label: 'Firmă din Uniunea Europeană' },
  { id: 'non_eu', label: 'Firmă din afara Uniunii Europene' },
] as const;
const romanian = new Set([
  'ro_legal_entity',
  'ro_individual_enterprise',
  'ro_individual',
  'ro_public_institution',
]);

/** „Partener nou”: adds a partner (`parties.create`) and chooses it on the line. */
function PartyDialog({
  onClose,
  onChosen,
}: {
  onClose: () => void;
  onChosen: (partyId: string) => void;
}) {
  const { invoke, act } = useWorkspace();
  const [kind, setKind] = useState<string>('ro_legal_entity');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; existing?: string } | null>(null);
  const local = romanian.has(kind);
  const taxLabel =
    kind === 'ro_individual'
      ? 'CNP'
      : kind === 'eu_taxable'
        ? 'Cod de TVA'
        : local
          ? 'CUI'
          : 'Cod fiscal';
  return (
    <Dialog
      title="Partener nou"
      isOpen
      onOpenChange={(open) => !open && onClose()}
      isDismissable={false}
    >
      <form
        className="acc-stack"
        onSubmit={(event) => {
          // The dialog sits in the entry's form in React's tree: its submit is its own.
          event.preventDefault();
          event.stopPropagation();
          const data = new FormData(event.currentTarget);
          const value = (name: string) => String(data.get(name) ?? '').trim();
          const taxId = value('taxId');
          setBusy(true);
          setProblem(null);
          const made: { id?: string } = {};
          void act(
            async () => {
              made.id = (
                await invoke<Party>('parties.create', {
                  kind,
                  country: local ? 'RO' : value('country').toUpperCase(),
                  ...(taxId ? { taxId } : {}),
                  name: value('name'),
                })
              ).id;
            },
            'Partenerul a fost adăugat.',
            (reason) => {
              const details =
                reason instanceof ApiError && reason.details && typeof reason.details === 'object'
                  ? (reason.details as { partyId?: unknown })
                  : {};
              setProblem({
                message: reason instanceof Error ? reason.message : 'Partenerul nu a fost adăugat.',
                ...(typeof details.partyId === 'string' ? { existing: details.partyId } : {}),
              });
            },
          ).then((done) => {
            setBusy(false);
            if (done && made.id) onChosen(made.id);
          });
        }}
      >
        <Select
          label="Tip"
          options={partyKinds}
          value={kind}
          onChange={(chosen) => chosen && setKind(chosen)}
        />
        <TextField
          label="Denumire"
          name="name"
          autoFocus
          maxLength={300}
          validate={(value) => (value.trim() ? null : 'Completează denumirea partenerului.')}
        />
        <div className="acc-form-row">
          <TextField label={taxLabel} name="taxId" maxLength={40} />
          {local ? null : (
            <TextField
              label="Țara (cod din două litere)"
              name="country"
              maxLength={2}
              validate={(value) =>
                /^[A-Za-z]{2}$/.test(value.trim()) ? null : 'Scrie codul țării din două litere.'
              }
            />
          )}
        </div>
        {problem ? (
          <div role="alert" className="acc-entry-refusal">
            <p>{problem.message}</p>
            {problem.existing ? (
              <Button size="small" onPress={() => onChosen(problem.existing!)}>
                Alege partenerul existent
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="acc-form-actions">
          <Button type="submit" variant="primary" isDisabled={busy}>
            Adaugă partenerul
          </Button>
          <Button variant="quiet" onPress={onClose}>
            Renunță
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
