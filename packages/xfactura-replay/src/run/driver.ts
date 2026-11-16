import { derivedId } from 'xfactura-core/hash';
import { addDays, parseLocalDate, type LocalDate } from 'xfactura-core/time';
import type { Actor } from '../../../xfactura-api/source/engine/kernel/commands';
import { wireError } from '../../../xfactura-api/source/engine/kernel/errors';
import type { ProposalView } from '../../../xfactura-api/source/engine/kernel/views';
import type { Mapping } from '../mapping/schema';
import type { CompanyFiling } from '../mapping/corpus';
import { compareBalances, separateZeroPresence } from '../compare/balances';
import type { Cause } from '../compare/causes';
import {
  classes,
  difference,
  kinds,
  order,
  syntheticAccount,
  type Difference,
  type DifferenceClass,
  type Observation,
} from '../compare/differences';
import { readEngineBalances, readEngineJournals, type EngineTaxView } from '../compare/engine';
import { filedPeriod } from '../compare/filed';
import {
  compareJournals,
  migrationSubject,
  type SourceJournalTransaction,
} from '../compare/journals';
import { checkSourceChain } from '../compare/source-chain';
import type { DifferenceStore } from '../compare/store';
import { applyLabAssumptions, type AppliedAssumption, type LabAssumptions } from './assumptions';
import type { ReplayEngine } from './engine';
import { openingBalances, openingInputs, outsideDoubleEntry } from './opening';
import { blockRole, type ReadingTable } from './taxes';
import {
  invoiceIndex,
  ItemIndex,
  linkedDocuments,
  postingKey,
  transactionMonth,
  translateTransaction,
  type ReusedKey,
  type SettlementNote,
} from './translate';
import { ReplayMapping } from './view';

export class ReplayError extends Error {
  constructor(readonly code: string) {
    super(`${code}: Reluarea nu poate continua.`);
  }
}

type Refusal = NonNullable<NonNullable<Observation['context']>['refusal']>;
type Stage = Refusal['stage'];

/** A selected filing of one reporting interval. */
export type ReplayPeriod = { period: string; start: string; end: string; filing: CompanyFiling };

/** The facts of a filing that books are made of; generation metadata and the TaxTable's wording
 * do not change them. */
const booksOf = (filing: CompanyFiling) => {
  const { filed } = filing;
  return JSON.stringify([
    filed.header.selection,
    filed.header.defaultCurrency,
    filed.masterFiles.accounts,
    filed.masterFiles.customers,
    filed.masterFiles.suppliers,
    filed.generalLedgerEntries,
    filed.sourceDocuments,
  ]);
};

/**
 * One filing per reporting interval. Re-filings of an interval that state the same books
 * collapse to the latest created (then the greatest payload hash); re-filings that differ in
 * their books stop the run, since choosing between them is the owner's decision. `from` and `to`
 * (YYYY-MM) keep the intervals inside them.
 */
export function selectPeriods(
  filings: readonly CompanyFiling[],
  range: { from?: string; to?: string } = {},
): { periods: ReplayPeriod[]; collapsed: { period: string; sha256: string }[] } {
  const groups = new Map<string, CompanyFiling[]>();
  for (const filing of filings) {
    const { start, end } = filing.filed.header.selection;
    if (!start || !end) throw new ReplayError('FILING_SELECTION_MISSING');
    const key = `${start}/${end}`;
    groups.set(key, [...(groups.get(key) ?? []), filing]);
  }
  const periods: ReplayPeriod[] = [];
  const collapsed: { period: string; sha256: string }[] = [];
  for (const group of groups.values()) {
    if (new Set(group.map(booksOf)).size > 1) throw new ReplayError('PERIOD_REFILINGS_DIFFER');
    const [chosen, ...rest] = [...group].sort(
      (a, b) =>
        order(b.filed.header.created ?? '', a.filed.header.created ?? '') ||
        order(b.sha256, a.sha256),
    );
    const { period, from, to } = filedPeriod(chosen!.filed);
    if ((range.from && from.slice(0, 7) < range.from) || (range.to && to.slice(0, 7) > range.to))
      continue;
    periods.push({ period, start: from, end: to, filing: chosen! });
    for (const item of rest) collapsed.push({ period, sha256: item.sha256 });
  }
  periods.sort((a, b) => order(a.start, b.start));
  for (let i = 1; i < periods.length; i++)
    if (periods[i - 1]!.end >= periods[i]!.start) throw new ReplayError('PERIOD_OVERLAP');
  return { periods, collapsed: collapsed.sort((a, b) => order(a.period, b.period)) };
}

/** The run's private record: its filings, the assumptions it applied and how it used them. */
export type RunManifest = {
  alias: string;
  source: string;
  periods: { period: string; sha256: string }[];
  collapsed: { period: string; sha256: string }[];
  assumptions: { statedBy: string; applied: AppliedAssumption[] } | null;
};

export type ReplayInput = {
  alias: string;
  filings: readonly CompanyFiling[];
  mapping: Mapping;
  assumptions?: LabAssumptions;
  from?: string;
  to?: string;
  /** Opens the empty private engine, at the clock the run gives it. */
  open: (clock: number) => Promise<ReplayEngine>;
  store: DifferenceStore;
  causes?: readonly Cause[];
  readings?: ReadingTable;
};

const count = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};
const sorted = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => order(a, b)));
const synthetics = (accounts: Iterable<string>) =>
  [...new Set([...accounts].flatMap((account) => syntheticAccount(account) ?? []))].sort(order);

const balanceKinds = new Set<string>([
  'balance-field',
  'balance-only-source',
  'balance-only-engine',
  'balance-period-only-source',
  'balance-period-only-engine',
  'mapping-account',
]);
const sourceKinds = new Set<string>([
  'source-balance-both-sides',
  'source-tax-supplement',
  'source-chain-balance',
  'source-chain-evidence',
  'source-chain-only-previous',
  'source-chain-only-next',
  'source-chain-gap',
]);
/** Refusals that come from the mapping rather than from what the treatment can express. */
const mappingRefusals = new Set([
  'ACCOUNT_UNMAPPED',
  'PARTNER_UNMAPPED',
  'LINE_PARTNER_MISSING',
  'LINE_PARTNER_AMBIGUOUS',
  'PARTY_UNAVAILABLE',
]);

/** Only the tax entries that stand for a filed operation are compared, under the filed code. */
const taxView: EngineTaxView = (tax) =>
  tax.attributes.role === 'operation'
    ? {
        code: tax.attributes.saftTaxCode,
        base: tax.base,
        tax: tax.amount,
        deductible: tax.deductible,
        period: tax.taxPeriod,
      }
    : null;

/**
 * Replays a company's filed D406 journals through `migration.journal`, period by period, as the
 * company's owner: a new company from the D406 header, its analytic accounts, parties and source
 * files as evidence, the first period's opening, then every filed transaction proposed, approved
 * on its exact effect hash and posted, or refused with its reason. After each period the engine's
 * balances and journal are compared with the filed ones and every difference is reconciled in the
 * private store. A blocked mapping stops before the engine is opened.
 */
export async function replayCompany(input: ReplayInput) {
  const { periods, collapsed } = selectPeriods(input.filings, input);
  if (!periods.length) throw new ReplayError('NO_PERIODS');
  const first = periods[0]!;
  if (!first.start.endsWith('-01-01')) throw new ReplayError('FIRST_PERIOD_NOT_YEAR_START');
  for (const { filing } of periods)
    if (filing.filed.header.defaultCurrency !== 'RON') throw new ReplayError('CURRENCY_NOT_RON');
  const filed = periods.map((item) => item.filing.filed);
  const assumed = applyLabAssumptions(input.mapping, filed, input.assumptions);
  const byCode = (problems: { code: string }[]) => {
    const counts: Record<string, number> = {};
    for (const problem of problems) count(counts, problem.code);
    return sorted(counts);
  };
  const labAssumptions = {
    stated: input.assumptions !== undefined,
    applied: assumed.applied.length,
    byKind: sorted(
      assumed.applied.reduce<Record<string, number>>((counts, item) => {
        count(counts, item.kind);
        return counts;
      }, {}),
    ),
  };
  const manifest: RunManifest = {
    alias: input.alias,
    source: input.mapping.source,
    periods: periods.map((item) => ({ period: item.period, sha256: item.filing.sha256 })),
    collapsed,
    assumptions: input.assumptions
      ? { statedBy: input.assumptions.statedBy, applied: assumed.applied }
      : null,
  };
  if (assumed.blockers.length)
    return {
      status: 'blocked' as const,
      summary: {
        company: input.alias,
        status: 'blocked',
        periods: { selected: periods.length, refilingsCollapsed: collapsed.length },
        mapping: { blockers: byCode(assumed.blockers), waived: byCode(assumed.waived) },
        labAssumptions,
      },
      manifest: { ...manifest, blockers: assumed.blockers },
    };

  const view = new ReplayMapping(assumed.mapping, assumed.applied);
  const last = periods.at(-1)!;
  const books = await input.open(Date.parse(`${addDays(parseLocalDate(last.end), 1)}T12:00:00Z`));
  try {
    return await run(input, periods, collapsed, view, books, {
      manifest,
      mapping: { blockers: {}, waived: byCode(assumed.waived) },
      labAssumptions,
    });
  } finally {
    await books.close();
  }
}

async function run(
  input: ReplayInput,
  periods: ReplayPeriod[],
  collapsed: { period: string; sha256: string }[],
  view: ReplayMapping,
  books: ReplayEngine,
  base: {
    manifest: RunManifest;
    mapping: { blockers: Record<string, number>; waived: Record<string, number> };
    labAssumptions: Record<string, unknown>;
  },
) {
  const first = periods[0]!;
  const header = first.filing.filed.header.company;
  const cui = header.registrationNumber?.replace(/\s+/g, '').replace(/^RO/i, '') ?? '';
  const name = header.name?.trim().slice(0, 200) ?? '';
  if (!/^\d{2,10}$/.test(cui) || name.length < 2) throw new ReplayError('COMPANY_IDENTITY');
  const company = await books.engine.companies.create(books.person, books.ids(), {
    name,
    cui,
    year: Number(first.start.slice(0, 4)),
  });
  const owner: Actor = { actorId: books.person, companyId: company.id };
  const invoke = async <T>(operation: string, body: unknown): Promise<T> =>
    (await books.engine.invoke(owner, operation, books.ids(), body)) as T;
  /** Only an assumption about an account's mapping makes a finding the mapping's. */
  const accountAssumed = (ids: readonly string[]) => ids.some((id) => view.isAccountAssumption(id));
  const refusalOf = (stage: Stage, error: unknown): Refusal => {
    const wire = wireError(error).error;
    const details = wire.details as { invariant?: unknown } | undefined;
    // Every database invariant's code is kept, also those surfacing as one public code.
    const code =
      typeof details?.invariant === 'string' ? `${wire.code}:${details.invariant}` : wire.code;
    return { stage, code, message: wire.message };
  };

  // Years, analytic accounts, parties and the source files as evidence.
  const years = new Map<number, string>();
  const listed = await invoke<{ items: { id: string; kind: string; from: string }[] }>(
    'years.list',
    {},
  );
  for (const year of listed.items)
    if (year.kind === 'financial') years.set(Number(year.from.slice(0, 4)), year.id);
  const ensureYear = async (year: number) => {
    if (years.has(year)) return years.get(year)!;
    let created: { id: string } | undefined;
    for (const kind of ['financial', 'fiscal'] as const) {
      const result = await invoke<{ id: string }>('years.create', {
        kind,
        label: String(year),
        from: `${year}-01-01`,
        to: `${year}-12-31`,
      });
      if (kind === 'financial') created = result;
    }
    years.set(year, created!.id);
    return created!.id;
  };
  const setup = {
    analyticsCreated: 0,
    analyticsRefused: {} as Record<string, number>,
    partiesCreated: 0,
    partiesRefused: {} as Record<string, number>,
    evidence: 0,
  };
  for (const account of view.analytics())
    try {
      await invoke('accounts.create', {
        code: account.code,
        name: account.name.slice(0, 300),
        validFrom: first.start,
      });
      setup.analyticsCreated++;
    } catch (error) {
      count(setup.analyticsRefused, refusalOf('propose', error).code);
    }
  const partyIds = new Map<string, string>();
  for (const { key, party } of view.parties)
    try {
      const created = await invoke<{ id: string }>('parties.create', {
        kind: party.kind,
        country: party.country,
        ...(party.taxId ? { taxId: party.taxId } : {}),
        name: party.name,
      });
      partyIds.set(key, created.id);
      setup.partiesCreated++;
    } catch (error) {
      count(setup.partiesRefused, refusalOf('propose', error).code);
    }
  const evidence = new Map<ReplayPeriod, string>();
  for (const period of periods) {
    const recorded = await invoke<{ id: string }>('evidence.record', {
      filename: `d406-${period.start}-${period.end}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(period.filing.xml).toString('base64'),
    });
    evidence.set(period, recorded.id);
    setup.evidence++;
  }

  const items = new ItemIndex();
  const acknowledged: Record<string, number> = {};
  /** Proposes as the owner, approves the exact effect hash with its warnings and posts. */
  const book = async (
    treatment: string,
    body: unknown,
    newItems: { ref: string; key: string }[],
  ): Promise<{ ok: true; proposal: ProposalView } | { ok: false; refusal: Refusal }> => {
    let proposal: ProposalView;
    try {
      proposal = await invoke<ProposalView>(`${treatment}.propose`, body);
    } catch (error) {
      return { ok: false, refusal: refusalOf('propose', error) };
    }
    if (proposal.status === 'blocked' || !proposal.effect) {
      const codes = [
        ...new Set(
          proposal.issues.filter((issue) => issue.severity === 'block').map((i) => i.code),
        ),
      ].sort(order);
      return {
        ok: false,
        refusal: {
          stage: 'proposal',
          code: codes.join('+') || 'BLOCKED',
          message: proposal.issues.map((issue) => issue.message).join(' '),
          issues: codes,
        },
      };
    }
    if (proposal.status !== 'posted') {
      const acknowledge = proposal.issues
        .filter((issue) => issue.severity === 'ack')
        .map((issue) => issue.code);
      try {
        proposal = await invoke<ProposalView>('proposals.approve', {
          proposalId: proposal.id,
          version: proposal.version,
          effectHash: proposal.effectHash,
          acknowledge,
        });
      } catch (error) {
        return { ok: false, refusal: refusalOf('approve', error) };
      }
      for (const code of acknowledge) count(acknowledged, code);
      try {
        proposal = await invoke<ProposalView>('ledger.post', {
          proposalId: proposal.id,
          version: proposal.version,
          effectHash: proposal.effectHash,
        });
      } catch (error) {
        return { ok: false, refusal: refusalOf('post', error) };
      }
    }
    for (const { ref, key } of newItems) {
      const id = derivedId(proposal.id, 'openItem', ref);
      if (!proposal.effect?.openItems.some((item) => item.id === id))
        throw new ReplayError('OPEN_ITEM_IDENTITY');
      items.set(key, id);
    }
    return { ok: true, proposal };
  };

  // The opening of the first period, at the start of its financial year.
  const openingDate = first.start as LocalDate;
  const opening: Record<string, unknown> = { treatment: null };
  const openingSubjects = new Set<string>();
  const extra = new Map<string, Difference[]>();
  const openingRefused = (refusal: Refusal) =>
    extra.set(first.period, [
      ...(extra.get(first.period) ?? []),
      withContext(
        difference({
          kind: 'replay-opening-refused',
          period: first.period,
          locator: { subject: `opening:${openingDate}` },
          source: null,
          engine: refusal,
        }),
        { refusal, cause: { class: 'unsupported', reason: `refused:${refusal.code}` } },
      ),
    ]);
  const balances = openingBalances(first.filing.filed, view);
  if ('code' in balances) {
    opening.refused = balances.code;
    openingRefused({ stage: 'translate', code: balances.code, message: '' });
  } else {
    opening.balances = balances.balances.length;
    opening.unknown = balances.unknown;
    opening.outsideDoubleEntry = synthetics(balances.outside.map((item) => item.account));
    // Books that open with nothing post no opening entry.
    const inputs = !balances.balances.length
      ? null
      : openingInputs(balances.balances, {
          date: openingDate,
          evidenceId: evidence.get(first)!,
          source: view.source,
          partyId: (key) => partyIds.get(key),
        });
    if (inputs === null) opening.treatment = 'none';
    else if ('code' in inputs) {
      opening.refused = inputs.code;
      openingRefused({ stage: 'translate', code: inputs.code, message: '' });
    } else {
      opening.items = inputs.newItems.length;
      const general = await book('ledger.general', inputs.general, inputs.newItems);
      openingSubjects.add(`opening:${openingDate}`);
      if (general.ok) opening.treatment = 'ledger.general';
      else {
        // ledger.general records no tax entries: a VAT account's balance needs the journal.
        opening.ledgerGeneral = { stage: general.refusal.stage, code: general.refusal.code };
        opening.carriedVatAccounts = synthetics(
          balances.balances.filter((item) => item.tax).map((item) => item.account),
        );
        const subject = migrationSubject(view.source, `opening/${openingDate}`);
        openingSubjects.add(subject);
        const migration = await book('migration.journal', inputs.migration, inputs.newItems);
        if (migration.ok) opening.treatment = 'migration.journal';
        else {
          opening.migrationJournal = {
            stage: migration.refusal.stage,
            code: migration.refusal.code,
          };
          openingRefused(migration.refusal);
        }
      }
    }
  }

  // Every period's transactions, then its comparison.
  const invoices = invoiceIndex(
    periods.map((item) => item.filing.filed),
    view,
  );
  const read = <T>(operation: string, body: unknown) => invoke<T>(operation, body);
  const transactions = {
    read: 0,
    posted: 0,
    refused: 0,
    refusedByReason: {} as Record<string, number>,
  };
  const settlementCounts = {
    byDocument: 0,
    unallocated: {} as Record<string, number>,
    reusedKeys: 0,
    importMarkersAttached: 0,
  };
  const refusals: { reason: string; period: number; accounts: string[] }[] = [];
  const postings = new Map<string, 'posted' | 'refused'>();
  /** Engine accounts a refused transaction touched, and those a filed chain break moved. */
  const refusedAccounts = new Set<string>();
  const broken = new Set<string>();
  const diverged: { period: number; accounts: string[] }[] = [];
  const periodSummaries: Record<string, unknown>[] = [];
  const touched = new Map<string, number>();
  const reconciled: Difference[] = [];
  const causes = input.causes ?? [];
  for (const [index, period] of periods.entries()) {
    const yearId = await ensureYear(Number(period.start.slice(0, 4)));
    const filedPeriodBooks = period.filing.filed;
    const links = linkedDocuments(filedPeriodBooks);
    const context = {
      mapping: view,
      filed: filedPeriodBooks,
      periodStart: period.start,
      evidenceId: evidence.get(period)!,
      items,
      partyId: (key: string) => partyIds.get(key),
      invoices,
      postings,
      ...(input.readings ? { readings: input.readings } : {}),
    };
    const sources = new Map<string, SourceJournalTransaction>();
    const refused = new Map<string, Refusal>();
    const assumptionsBySubject = new Map<string, string[]>();
    const notes: {
      subject: string;
      month: string;
      note: SettlementNote;
      assumptions: string[];
      notes: string[];
    }[] = [];
    const reusedKeys: {
      subject: string;
      month: string;
      reuse: ReusedKey;
      assumptions: string[];
      notes: string[];
    }[] = [];
    const notesBySubject = new Map<string, string[]>();
    const references = new Set<string>();
    let posted = 0;
    for (const journal of filedPeriodBooks.generalLedgerEntries.journals)
      for (const transaction of journal.transactions) {
        transactions.read++;
        const translated = translateTransaction(journal, transaction, context, links);
        if (references.has(translated.reference)) throw new ReplayError('REFERENCE_DUPLICATE');
        references.add(translated.reference);
        const subject = migrationSubject(view.source, translated.reference);
        sources.set(subject, translated.comparison);
        assumptionsBySubject.set(subject, translated.assumptions);
        notesBySubject.set(subject, translated.notes);
        for (const id of translated.assumptions) touched.set(id, (touched.get(id) ?? 0) + 1);
        let refusal: Refusal | undefined;
        if (!translated.ok) refusal = { stage: 'translate', ...translated.refusal };
        else {
          const result = await book('migration.journal', translated.input, translated.newItems);
          if (result.ok) {
            posted++;
            transactions.posted++;
            settlementCounts.byDocument += translated.settledByDocument;
            settlementCounts.reusedKeys += translated.reused.length;
            for (const reuse of translated.reused)
              reusedKeys.push({
                subject,
                month: transactionMonth(transaction) ?? period.period,
                reuse,
                assumptions: translated.assumptions,
                notes: translated.notes,
              });
            settlementCounts.importMarkersAttached += translated.notes.filter(
              (note) => note === 'IMPORT_MARKER_ATTACHED',
            ).length;
            for (const note of translated.settlements) {
              count(settlementCounts.unallocated, note.reason);
              notes.push({
                subject,
                month: transactionMonth(transaction) ?? period.period,
                note,
                assumptions: translated.assumptions,
                notes: translated.notes,
              });
            }
          } else refusal = result.refusal;
        }
        postings.set(postingKey(period.start, transaction.id), refusal ? 'refused' : 'posted');
        if (refusal) {
          refused.set(subject, refusal);
          transactions.refused++;
          const reason = `${refusal.stage}:${refusal.code}`;
          count(transactions.refusedByReason, reason);
          refusals.push({ reason, period: index, accounts: translated.accounts });
        }
      }

    // Balances: the period's own comparison and the filed chain from the previous period.
    const engineBalances = await readEngineBalances(read, yearId, period.start, period.end);
    const balanceResult = compareBalances(
      [filedPeriodBooks],
      [engineBalances],
      view.engineAccount,
      {
        zeroPresence: 'separate',
      },
    );
    const previous = periods[index - 1];
    const chain = previous
      ? separateZeroPresence(
          checkSourceChain([previous.filing.filed, filedPeriodBooks]).findings.filter(
            (item) => item.kind !== 'source-balance-both-sides',
          ),
        )
      : [];
    for (const item of chain)
      if (
        item.locator.sourceAccount !== undefined &&
        item.kind !== 'source-chain-presence-zero' &&
        item.kind !== 'source-chain-gap'
      ) {
        const account = view.engineAccount(item.locator.sourceAccount);
        if (account) broken.add(account);
      }
    for (const refusal of refusals)
      for (const account of refusal.accounts) refusedAccounts.add(account);
    const balanceDifferences = [...balanceResult.differences, ...chain].map((item) => {
      const assumptions = [
        ...new Set([
          ...(item.locator.account ? view.engineAccountAssumptions(item.locator.account) : []),
          ...(item.locator.account && balanceKinds.has(item.kind)
            ? view.placeholderAccountAssumptions(item.locator.account)
            : []),
          ...(item.locator.sourceAccount
            ? view.sourceAccountAssumptions(item.locator.sourceAccount)
            : []),
        ]),
      ].sort(order);
      return withContext(item, {
        ...(assumptions.length ? { assumptions } : {}),
        ...causeOf(item, accountAssumed(assumptions), {
          refused: refusedAccounts,
          broken,
        }),
      });
    });
    // Journals: every posted migration entry of the period but the opening.
    const engineEntries = (
      await readEngineJournals(read, period.start, period.end, 500, taxView)
    ).filter(
      (entry) =>
        entry.subject.startsWith(`migration:${view.source}:`) &&
        !openingSubjects.has(entry.subject),
    );
    const journalDifferences = compareJournals(
      [...sources.values()],
      engineEntries,
      view.engineAccount,
    ).map((item) => {
      const subject = item.locator.subject;
      const assumptions = subject ? (assumptionsBySubject.get(subject) ?? []) : [];
      const translation = subject ? (notesBySubject.get(subject) ?? []) : [];
      const refusal = subject ? refused.get(subject) : undefined;
      if (refusal && item.kind === 'journal-only-source')
        return withContext(
          { ...item, engine: { refused: refusal } },
          {
            ...(assumptions.length ? { assumptions } : {}),
            ...(translation.length ? { notes: translation } : {}),
            refusal,
            cause: {
              class: mappingRefusals.has(refusal.code) ? 'mapping' : 'unsupported',
              reason: `refused:${refusal.code}`,
            },
          },
        );
      const source = subject ? sources.get(subject) : undefined;
      const tax = item.kind === 'journal-tax' || item.kind === 'journal-tax-evidence';
      const filed = source?.transaction.lines.flatMap((line) => line.tax ?? []) ?? [];
      // A tax withheld at source has no place in the journal treatment; a VAT marker a return
      // needs states no base, so the engine holds none for it.
      const otherTax = tax && filed.some((block) => block.type !== '300');
      const baseless = tax && filed.some((block) => blockRole(block) === 'marker');
      return withContext(item, {
        ...(assumptions.length ? { assumptions } : {}),
        ...(translation.length ? { notes: translation } : {}),
        ...(otherTax
          ? { cause: { class: 'unsupported' as const, reason: 'TAX_WITHOUT_PLACE' } }
          : baseless
            ? { cause: { class: 'missing-evidence' as const, reason: 'MARKER_WITHOUT_BASE' } }
            : causeOf(item, accountAssumed(assumptions))),
      });
    });
    const settlementDifferences = notes.map(({ subject, month, note, assumptions, notes }) =>
      withContext(
        difference({
          kind: 'replay-settlement-unallocated',
          period: month,
          locator: { subject, field: `lines.${note.line}` },
          accounts: [note.account],
          source: note.document,
          engine: { reason: note.reason },
        }),
        {
          ...(assumptions.length ? { assumptions } : {}),
          ...(notes.length ? { notes } : {}),
          cause: { class: note.class, reason: note.reason },
        },
      ),
    );
    // An invoice whose document key already names an item opens its own; the key is ambiguous
    // from then on, and payments naming it go to the party's unallocated item.
    const reuseDifferences = reusedKeys.map(({ subject, month, reuse, assumptions, notes }) =>
      withContext(
        difference({
          kind: 'replay-invoice-key-reused',
          period: month,
          locator: { subject, field: `lines.${reuse.line}` },
          accounts: [reuse.account],
          source: reuse.document,
          engine: { reason: 'INVOICE_KEY_REUSED' },
        }),
        {
          ...(assumptions.length ? { assumptions } : {}),
          ...(notes.length ? { notes } : {}),
          cause: { class: 'source-inconsistency', reason: 'INVOICE_KEY_REUSED' },
        },
      ),
    );
    reconciled.push(
      ...(
        await input.store.reconcile(`balances:${period.period}`, balanceDifferences, causes)
      ).filter((item) => item.scope === `balances:${period.period}`),
      ...(
        await input.store.reconcile(`journals:${period.period}`, journalDifferences, causes)
      ).filter((item) => item.scope === `journals:${period.period}`),
      ...(
        await input.store.reconcile(
          `replay:${period.period}`,
          [...settlementDifferences, ...reuseDifferences, ...(extra.get(period.period) ?? [])],
          causes,
        )
      ).filter((item) => item.scope === `replay:${period.period}`),
    );
    const balanceFindings = balanceDifferences.filter((item) => balanceKinds.has(item.kind));
    diverged.push({
      period: index,
      accounts: balanceFindings.flatMap((item) => item.accounts),
    });
    periodSummaries.push({
      period: period.period,
      transactions: references.size,
      posted,
      refused: refused.size,
      balanced: balanceFindings.length === 0,
      balanceDifferences: balanceFindings.length,
      journalDifferences: journalDifferences.length,
    });
  }

  // Which refusals touched accounts whose balances diverged then or later.
  const refusalsAndBalances: Record<
    string,
    { transactions: number; accounts: string[]; divergedAccounts: string[] }
  > = {};
  const explained = new Set<string>();
  for (const reason of new Set(refusals.map((item) => item.reason))) {
    const own = refusals.filter((item) => item.reason === reason);
    const accounts = new Set(own.flatMap((item) => item.accounts));
    const later = new Set(
      diverged
        .filter((item) => item.period >= Math.min(...own.map((refusal) => refusal.period)))
        .flatMap((item) => item.accounts)
        .filter((account) => accounts.has(account)),
    );
    for (const account of later) explained.add(account);
    refusalsAndBalances[reason] = {
      transactions: own.length,
      accounts: synthetics(accounts),
      divergedAccounts: synthetics(later),
    };
  }
  const open = reconciled.filter((item) => item.status === 'open');
  const byClass = Object.fromEntries(classes.map((name) => [name, 0])) as Record<
    DifferenceClass,
    number
  >;
  const byKind: Record<string, number> = {};
  for (const item of open) {
    byClass[item.class]++;
    count(byKind, item.kind);
  }
  const summary = {
    company: input.alias,
    status: 'completed',
    periods: {
      selected: periods.length,
      refilingsCollapsed: collapsed.length,
      balanced: periodSummaries.filter((item) => item.balanced).length,
      list: periodSummaries,
    },
    mapping: base.mapping,
    labAssumptions: {
      ...base.labAssumptions,
      touchedTransactions: [...touched.values()].reduce((sum, value) => sum + value, 0),
      touchedDifferences: open.filter((item) => item.context?.assumptions?.length).length,
    },
    setup: {
      ...setup,
      analyticsRefused: sorted(setup.analyticsRefused),
      partiesRefused: sorted(setup.partiesRefused),
    },
    opening,
    transactions: {
      ...transactions,
      refusedByReason: sorted(transactions.refusedByReason),
      acknowledgedWarnings: sorted(acknowledged),
    },
    items: {
      created: items.size,
      settledByDocument: settlementCounts.byDocument,
      unallocatedSettlements: sorted(settlementCounts.unallocated),
      invoiceKeysReused: settlementCounts.reusedKeys,
      importMarkersAttached: settlementCounts.importMarkersAttached,
    },
    refusalsAndBalances: sorted(refusalsAndBalances),
    divergedAfterFiledChainBreak: synthetics(
      diverged
        .flatMap((item) => item.accounts)
        .filter((account) => !explained.has(account) && broken.has(account)),
    ),
    divergedOtherwise: synthetics(
      diverged
        .flatMap((item) => item.accounts)
        .filter((account) => !explained.has(account) && !broken.has(account)),
    ),
    differences: {
      total: open.length,
      byClass,
      byKind: sorted(
        Object.fromEntries(
          kinds.filter((kind) => byKind[kind]).map((kind) => [kind, byKind[kind]!]),
        ),
      ),
    },
  };
  return {
    status: 'completed' as const,
    summary,
    manifest: {
      ...base.manifest,
      evidence: periods.map((item) => ({ period: item.period, evidenceId: evidence.get(item) })),
      assumptionsTouched: Object.fromEntries([...touched].sort(([a], [b]) => order(a, b))),
    },
  };
}

/**
 * The class a finding's kind gives it, when the driver knows it. A balance of an account that a
 * refused transaction touched stays unclassified: the refusal explains it only in part, and the
 * summary attributes it. Otherwise a balance after a break in the filed chain is the filed file's
 * disagreement carried on, and one resting on a lab assumption is the mapping's.
 */
function causeOf(
  item: Difference,
  assumed: boolean,
  accounts: { refused: ReadonlySet<string>; broken: ReadonlySet<string> } = {
    refused: new Set(),
    broken: new Set(),
  },
): NonNullable<Observation['context']> {
  if (sourceKinds.has(item.kind))
    return { cause: { class: 'source-inconsistency', reason: 'FILED_FILE_DISAGREES' } };
  if (item.kind === 'balance-presence-zero' || item.kind === 'source-chain-presence-zero')
    return { cause: { class: 'comparator', reason: 'ZERO_PRESENCE' } };
  if (
    balanceKinds.has(item.kind) &&
    item.locator.account !== undefined &&
    outsideDoubleEntry(item.locator.account)
  )
    return { cause: { class: 'unsupported', reason: 'OUTSIDE_DOUBLE_ENTRY' } };
  const account = balanceKinds.has(item.kind) ? item.locator.account : undefined;
  if (account !== undefined && accounts.refused.has(account)) return {};
  if (account !== undefined && accounts.broken.has(account))
    return { cause: { class: 'source-inconsistency', reason: 'AFTER_FILED_CHAIN_BREAK' } };
  if (
    assumed &&
    (balanceKinds.has(item.kind) ||
      ['journal-lines', 'journal-only-source', 'journal-only-engine', 'journal-period'].includes(
        item.kind,
      ))
  )
    return { cause: { class: 'mapping', reason: 'LAB_ASSUMPTION' } };
  return {};
}

function withContext(item: Difference, context: NonNullable<Observation['context']>): Difference {
  return Object.keys(context).length ? { ...item, context } : item;
}
