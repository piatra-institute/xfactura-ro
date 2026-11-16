'use client';

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { ProposalView } from 'xfactura-api/contracts';
import { companyPath } from './api';
import { useAccountingNavigation } from './navigation';
import { AccountingTime, formatAmount, useOpenedHeading } from './presentation';
import { ActorName } from './record-names';
import { useAccountingData } from './use-data';
import { treatmentLabels } from './work-model';
import { useWorkspace, type Workspace, type Year } from './workspace';

export type Pair = { debit: string; credit: string };
export type JournalLine = { account: string; side: 'D' | 'C'; amount: string | null };
export type JournalEntry = {
  id: string;
  number: number;
  seq: number;
  date: string;
  journalCode: string;
  description: string;
  proposalId: string;
  binding: 'approval' | 'policy';
  document: { type: string; number: string | null; date: string } | null;
  lines: JournalLine[];
  redacted?: true;
};
export type JournalPage = { entries: JournalEntry[]; next: number | null };

/** The synthetic account a ledger account belongs to (`4111.01` is read under `4111`). */
export const syntheticOf = (account: string) => account.split('.')[0]!;

/** The last day of an engine month (YYYY-MM), as an ISO date. */
function monthEnd(month: string) {
  const [year, part] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, part!, 0)).toISOString().slice(0, 10);
}

/** The days of a month that lie inside the financial year, which may start or end mid-month. */
export function monthDays(month: string, year: Year | undefined) {
  const first = `${month}-01`;
  const last = monthEnd(month);
  return {
    from: year && first < year.from ? year.from : first,
    to: year && last > year.to ? year.to : last,
  };
}

export const failure = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

export const hiddenAmount = 'sumă ascunsă (date salariale)';

export function State({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: string;
  empty?: boolean;
  children?: ReactNode;
}) {
  if (loading) return <p aria-busy="true">Se încarcă…</p>;
  if (error)
    return (
      <p role="alert" className="acc-error">
        {error}
      </p>
    );
  if (empty) return <p className="acc-empty">{children}</p>;
  return null;
}

const bucharestMonth = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest',
  year: 'numeric',
  month: '2-digit',
});
/** The month it is now in Romania (YYYY-MM): what a person opening the registers expects. */
function currentMonth() {
  const parts = bucharestMonth.formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}`;
}

/**
 * The month the registers show: the one in the address when it lies inside the selected financial
 * year, otherwise the current month held to the year. The month shown is always written into the
 * address, so a link or the browser's history keeps it.
 */
export function useRegisterMonth() {
  const { year } = useWorkspace();
  const { params, replace } = useAccountingNavigation();
  const requested = params.get('registerMonth');
  const first = year?.from.slice(0, 7) ?? null;
  const last = year?.to.slice(0, 7) ?? null;
  let month: string | null = null;
  if (first && last) {
    if (
      requested &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) &&
      first <= requested &&
      requested <= last
    )
      month = requested;
    else {
      const now = currentMonth();
      month = now < first ? first : now > last ? last : now;
    }
  }
  useEffect(() => {
    if (month && requested !== month) replace({ registerMonth: month });
  }, [month, requested]);
  return { month, first, last };
}

/** The month choice, held to the months of the selected financial year. */
export function MonthChoice({
  month,
  first,
  last,
}: {
  month: string;
  first: string;
  last: string;
}) {
  const { filter } = useAccountingNavigation();
  return (
    <div className="acc-work-filters">
      <label>
        Luna
        <input
          type="month"
          value={month}
          min={first}
          max={last}
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen && first <= chosen && chosen <= last)
              filter({ registerMonth: chosen, vatPeriod: null });
          }}
        />
      </label>
    </div>
  );
}

/** Every entry of the journal between two days, following the engine's cursor. */
async function readJournal(invoke: Workspace['invoke'], from: string, to: string) {
  const entries: JournalEntry[] = [];
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const result = await invoke<JournalPage>('ledger.journal', { from, to, after, limit: 500 });
    entries.push(...result.entries);
    if (result.next === null) return { entries, complete: true };
    after = result.next;
  }
  return { entries, complete: false };
}

/** The journal's entries between two days, read whole; `complete` is false past 25,000. */
export function useJournalBetween(from: string, to: string, enabled: boolean) {
  const { invoke, version } = useWorkspace();
  const key = `${from}|${to}|${version}`;
  const [state, setState] = useState<{
    key: string;
    entries: JournalEntry[];
    complete: boolean;
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !from || !to) return;
    let active = true;
    readJournal(invoke, from, to)
      .then((read) => {
        if (active) setState({ key, ...read, error: '' });
      })
      .catch((reason: unknown) => {
        if (active)
          setState({
            key,
            entries: [],
            complete: false,
            error: failure(reason, 'Registrul jurnal nu a putut fi citit.'),
          });
      });
    return () => {
      active = false;
    };
  }, [invoke, key, enabled]);
  const current = enabled && state?.key === key ? state : null;
  return {
    loading: enabled && Boolean(from && to) && !current,
    error: current?.error ?? '',
    entries: current?.entries ?? [],
    complete: current?.complete ?? false,
  };
}

/** The address filters that open one entry; its date lets the entry be read from that day alone. */
export const entryFilters = (entry: { id: string; date: string }) => ({
  registerEntry: entry.id,
  registerEntryDate: entry.date,
});

/** A link to one entry, as a native link that also opens in a new tab. */
export function EntryLink({
  entry,
  label,
  children,
}: {
  entry: { id: string; date: string };
  label?: string;
  children: ReactNode;
}) {
  const { href } = useAccountingNavigation();
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, '', event.currentTarget.href);
  };
  return (
    <a href={href('registers', entryFilters(entry))} onClick={follow} aria-label={label}>
      {children}
    </a>
  );
}

type EvidenceReading = {
  pages?: {
    page: number;
    lines: { line: number; text: string; part?: number; parts?: number }[];
  }[];
  next?: string | null;
};

/** An original's text as the engine reads it: a long line sent in parts is joined back whole. */
async function readEvidenceText(invoke: Workspace['invoke'], id: string) {
  const lines: string[] = [];
  let cursor: string | null = null;
  for (let call = 0; call < 20; call += 1) {
    const reading: EvidenceReading = await invoke<EvidenceReading>('evidence.read', {
      id,
      mode: 'text',
      ...(cursor ? { cursor } : {}),
    });
    for (const sheet of reading.pages ?? [])
      for (const line of sheet.lines) {
        if (line.part && line.part > 1 && lines.length > 0) lines[lines.length - 1] += line.text;
        else lines.push(line.text);
      }
    cursor = reading.next ?? null;
    if (!cursor) return { text: lines.join('\n'), partial: false };
  }
  return { text: lines.join('\n'), partial: true };
}

function useEvidenceText(evidenceId: string | null, enabled: boolean) {
  const { invoke } = useWorkspace();
  const [state, setState] = useState<{
    id: string;
    text: string;
    partial: boolean;
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!evidenceId || !enabled) return;
    let active = true;
    readEvidenceText(invoke, evidenceId)
      .then((read) => {
        if (active) setState({ id: evidenceId, ...read, error: '' });
      })
      .catch((reason: unknown) => {
        if (active)
          setState({
            id: evidenceId,
            text: '',
            partial: false,
            error: failure(reason, 'Documentul nu a putut fi citit.'),
          });
      });
    return () => {
      active = false;
    };
  }, [invoke, evidenceId, enabled]);
  const current = enabled && evidenceId && state?.id === evidenceId ? state : null;
  return {
    loading: enabled && Boolean(evidenceId) && !current,
    text: current?.text ?? '',
    partial: current?.partial ?? false,
    error: current?.error ?? '',
  };
}

/** The original file behind an entry, or one plain sentence saying why it cannot open here. */
function OriginalDocument({
  entry,
  proposal,
  proposalLoading,
}: {
  entry: JournalEntry;
  proposal: ProposalView | null;
  proposalLoading: boolean;
}) {
  const { can, company } = useWorkspace();
  const input = proposal?.input ?? null;
  const documentId = typeof input?.documentId === 'string' ? input.documentId : null;
  const directEvidenceId = typeof input?.evidenceId === 'string' ? input.evidenceId : null;
  const readDocument = Boolean(documentId && !directEvidenceId) && can('documents.get');
  const documentRead = useAccountingData<{ evidenceId: string | null }>(
    'documents.get',
    { id: documentId },
    readDocument,
  );
  const evidenceId = directEvidenceId ?? (readDocument ? documentRead.data?.evidenceId : null);
  const reading = useEvidenceText(evidenceId ?? null, can('evidence.read'));
  const justifying = entry.document
    ? `${entry.document.type}${entry.document.number ? ` ${entry.document.number}` : ''}`
    : null;

  let notice: ReactNode = null;
  if (!can('proposals.get'))
    notice =
      'Rolul dumneavoastră nu poate citi propunerea acestei înregistrări, deci nici documentul ei original.';
  else if (proposalLoading || (readDocument && documentRead.loading))
    notice = <span aria-busy="true">Se încarcă…</span>;
  else if (!proposal)
    notice = 'Documentul original nu poate fi găsit fără propunerea înregistrării.';
  else if (proposal.redacted)
    notice =
      'Propunerea conține date pe care rolul dumneavoastră nu le poate citi; documentul original nu poate fi deschis de aici.';
  else if (documentId && !directEvidenceId && !can('documents.get'))
    notice = 'Rolul dumneavoastră nu poate citi documentul acestei înregistrări.';
  else if (documentRead.error)
    notice = (
      <span role="alert" className="acc-error">
        {documentRead.error}
      </span>
    );
  else if (!evidenceId)
    notice = justifying
      ? `Fișierul original al documentului justificativ (${justifying}) nu poate fi deschis de aici: motorul nu îl leagă de această înregistrare.`
      : 'Motorul nu leagă de această înregistrare un fișier original.';

  return (
    <section>
      <h4>Document original</h4>
      {notice ? <p className="acc-empty">{notice}</p> : null}
      {!notice && evidenceId ? (
        <>
          {can('evidence.get') ? (
            <p>
              <a href={`${companyPath(company.id)}/evidence/${encodeURIComponent(evidenceId)}`}>
                Descarcă documentul original
              </a>
            </p>
          ) : null}
          {!can('evidence.read') ? (
            <p className="acc-empty">Rolul dumneavoastră nu poate citi textul documentului.</p>
          ) : (
            <>
              <State loading={reading.loading} error={reading.error} />
              {reading.text ? <pre className="acc-evidence-text">{reading.text}</pre> : null}
              {reading.partial ? (
                <p className="acc-hint">
                  Textul este afișat parțial; documentul este mai lung decât se citește aici.
                </p>
              ) : null}
              {!reading.loading && !reading.error && !reading.text ? (
                <p className="acc-empty">Motorul nu citește text în acest document.</p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

/** One entry: its lines, its proposal (who proposed, who approved which hash) and its original. */
export function EntryDetail({
  entryId,
  entryDate,
  month,
}: {
  entryId: string;
  entryDate: string | null;
  month: string;
}) {
  const { can, year } = useWorkspace();
  const { filter } = useAccountingNavigation();
  const day = entryDate && /^\d{4}-\d{2}-\d{2}$/.test(entryDate) ? entryDate : null;
  const range = day ? { from: day, to: day } : monthDays(month, year);
  const journal = useJournalBetween(range.from, range.to, can('ledger.journal'));
  const entry = journal.entries.find((row) => row.id === entryId) ?? null;
  const heading = useOpenedHeading(Boolean(entry));
  const proposalRead = useAccountingData<ProposalView>(
    'proposals.get',
    { id: entry?.proposalId },
    Boolean(entry) && can('proposals.get'),
  );
  const proposal = proposalRead.data;
  const amount = (line: JournalLine, side: 'D' | 'C') =>
    line.side !== side ? '' : line.amount === null ? hiddenAmount : formatAmount(line.amount);
  const where = day ? ` din ${day}` : ' din luna aleasă';

  return (
    <section>
      <button
        className="acc-secondary acc-entry-back"
        onClick={() => filter({ registerEntry: null, registerEntryDate: null })}
      >
        Înapoi la registru
      </button>
      {!can('ledger.journal') ? (
        <p className="acc-empty">Rolul dumneavoastră nu poate citi registrul jurnal.</p>
      ) : (
        <State
          loading={journal.loading}
          error={journal.error}
          empty={!journal.loading && !journal.error && !entry}
        >
          {journal.complete
            ? `Înregistrarea nu se găsește în registrul jurnal${where}.`
            : `Înregistrarea nu se găsește în primele ${journal.entries.length} înregistrări${where}.`}
        </State>
      )}
      {entry ? (
        <>
          <h3 ref={heading} tabIndex={-1} className="acc-opened-heading">
            Înregistrarea {entry.number} · {entry.date}
          </h3>
          <dl className="acc-work-details">
            <div>
              <dt>Jurnal</dt>
              <dd>{entry.journalCode}</dd>
            </div>
            <div>
              <dt>Descriere</dt>
              <dd>{entry.description}</dd>
            </div>
            {entry.document ? (
              <div>
                <dt>Document justificativ</dt>
                <dd>
                  {entry.document.type}
                  {entry.document.number ? ` ${entry.document.number}` : ''} · {entry.document.date}
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="acc-table-scroll">
            <table className="acc-register-table">
              <caption>Sume în RON</caption>
              <thead>
                <tr>
                  <th scope="col">Cont</th>
                  <th scope="col">Debit</th>
                  <th scope="col">Credit</th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((line, index) => (
                  <tr key={index}>
                    <td className="acc-text" data-label="Cont">
                      {line.account}
                    </td>
                    <td data-label="Debit">{amount(line, 'D')}</td>
                    <td data-label="Credit">{amount(line, 'C')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section>
            <h4>Propunere și aprobare</h4>
            {!can('proposals.get') ? (
              <p className="acc-empty">
                Rolul dumneavoastră nu poate citi propunerea acestei înregistrări.
              </p>
            ) : (
              <State
                loading={proposalRead.loading}
                error={proposalRead.error}
                empty={!proposalRead.loading && !proposal}
              >
                Propunerea nu este disponibilă.
              </State>
            )}
            {proposal ? (
              <dl className="acc-work-details">
                <div>
                  <dt>Tratament</dt>
                  <dd>{treatmentLabels[proposal.treatment] ?? proposal.treatment}</dd>
                </div>
                <div>
                  <dt>Propusă de</dt>
                  <dd>
                    <ActorName person={proposal.createdBy} agent={proposal.agentId} />
                  </dd>
                </div>
                {proposal.approval ? (
                  <div>
                    <dt>Aprobată de</dt>
                    <dd>
                      <ActorName person={proposal.approval.approverId} /> ·{' '}
                      <AccountingTime instant={proposal.approval.at} />
                    </dd>
                  </div>
                ) : (
                  <div>
                    <dt>Aprobare</dt>
                    <dd>
                      {proposal.entry?.policyId
                        ? 'Contabilizată printr-o politică aprobată de o persoană; nicio persoană nu a aprobat această versiune anume.'
                        : 'Motorul nu arată o aprobare pentru această versiune.'}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{proposal.approval ? 'Versiunea aprobată' : 'Versiunea contabilizată'}</dt>
                  <dd>{proposal.version}</dd>
                </div>
                <div>
                  <dt>
                    {proposal.approval
                      ? 'Amprenta efectului aprobat'
                      : 'Amprenta efectului contabilizat'}
                  </dt>
                  <dd>
                    <code>{proposal.effectHash}</code>
                  </dd>
                </div>
                {proposal.entry ? (
                  <div>
                    <dt>Contabilizată de</dt>
                    <dd>
                      <ActorName person={proposal.entry.postedBy} agent={proposal.entry.agentId} />
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </section>
          <OriginalDocument
            entry={entry}
            proposal={proposal}
            proposalLoading={can('proposals.get') && proposalRead.loading}
          />
        </>
      ) : null}
    </section>
  );
}
