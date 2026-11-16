import { d300Rows } from 'xfactura-core/ro/declarations/d300';
import { readDeclaration } from 'xfactura-core/ro/declarations/read';
import {
  s1005F10Rows,
  s1005F20Rows,
  s1005F30Rows,
  s1005F40Rows,
} from 'xfactura-core/ro/annual/s1005';
import { s1005Formulas } from 'xfactura-core/ro/annual/s1005-accounts';
import type { D406FiledParty } from 'xfactura-core/ro/saft/read';
import { d406CodeReadings } from 'xfactura-core/ro/saft/tax-code-readings';
import { wireError } from '../../../xfactura-api/source/engine/kernel/errors';
import type { Cause } from '../compare/causes';
import { decimal, subtract } from '../compare/decimal';
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
import {
  catalogueFor,
  compareReturns,
  differenceClasses,
  ReturnComparisonError,
  type ReturnDifference,
} from '../compare/returns';
import {
  replayCompany,
  type RefusedTransaction,
  type ReplayInput,
  type ReplayPeriod,
  type ReplaySession,
} from './driver';
import {
  deriveFacts,
  factAt,
  factStatements,
  partnerOf,
  sellerOf,
  type DerivedFact,
  type FactAxis,
  type FactConflict,
} from './facts';
import {
  d300OptionsOf,
  d394OptionsOf,
  d406OptionsOf,
  monthEnd,
  periodMonths,
  returnForms,
  s1005OptionsOf,
  selectReturns,
  storePeriod,
  type FiledReturn,
  type ReturnForm,
} from './filed-returns';

/** Why a return was not compared. */
export const blockedReasons = [
  /** The engine pins no ANAF format for the period (its FORMAT_GAP). */
  'FORMAT_GAP',
  /** The period holds the lab's opening, whose VAT balances the journal carried as CARRIED. */
  'LAB_OPENING',
  /** A profile fact the return needs is stated by no filed file; the engine's gap stopped it. */
  'FACT_MISSING',
  /** Income or expense accounts keep a balance at the year's end: the replayed books hold no
   * closing of them, which the statement needs (the accounts are listed). */
  'YEAR_NOT_CLOSED',
  /** The accounts are closed into 121, but by the accountant's own entries under their journal:
   * the statement reads the year's turnover without the engine's closing journal (INCHIDERE)
   * only, so those entries count as turnover and 121 is not the result. */
  'CLOSING_JOURNAL',
  /** The engine's own problems with the replayed books: an engine finding. */
  'ENGINE_PROBLEMS',
  /** The comparator refused the pair (form, version or period differ). */
  'COMPARISON_REFUSED',
  /** Re-filings of the period differ and none is the one rectifying return. */
  'FILED_REFILINGS_AMBIGUOUS',
  /** A half-yearly or annual VAT return, a period the engine does not prepare. */
  'FILED_PERIOD_KIND',
] as const;
export type BlockedReason = (typeof blockedReasons)[number];

const causeOfBlock: Partial<
  Record<BlockedReason, { class: Exclude<DifferenceClass, 'unclassified'> }>
> = {
  FORMAT_GAP: { class: 'unsupported' },
  LAB_OPENING: { class: 'unsupported' },
  FACT_MISSING: { class: 'missing-evidence' },
  COMPARISON_REFUSED: { class: 'comparator' },
  FILED_REFILINGS_AMBIGUOUS: { class: 'missing-evidence' },
  FILED_PERIOD_KIND: { class: 'unsupported' },
};

/**
 * The engine's problems that ask for a fact no filed file states, by the question a person
 * answers: F30's chapters and the rows of accounts the form spreads over several rows, the part
 * of F40's reductions that is scrapping, partners' addresses and identities, the bank accounts'
 * ledger accounts, D406's contact and standard accounts, D394's natures and series, the refund
 * choice, and the profile facts the engine's own checks name.
 */
const engineQuestions: Readonly<Record<string, string>> = {
  F30_CHAPTER: 'annual.informative',
  S1005_SPLIT: 'annual.rows',
  S1005_F40_SCRAPPED: 'annual.scrapped',
  S1005_PREVIOUS: 'annual.previous',
  ACTIVITY_UNKNOWN: 'activity.none',
  D406_PARTY_ADDRESS: 'party.details',
  D406_PARTY_CODE: 'party.identity',
  D406_BANK: 'treasury.accounts',
  D406_CONTACT: 'd406.contact',
  D406_ACCOUNT_CHOICE: 'd406.standardAccounts',
  D406_ACCOUNT_ID: 'd406.accountIds',
  D406_VAT_REGIME: 'vat.status',
  D394_NATURE: 'd394.natures',
  D394_SERIES: 'd394.series',
  D394_REFUND: 'd394.refund',
  D394_ADDRESS: 'party.details',
  D394_CNP: 'party.identity',
  VAT_REFUND_CHOICE: 'vat.refund',
  NOT_VAT_PAYER: 'vat.status',
  VAT_PERIOD: 'vat.period',
  SELLER_DETAILS: 'seller.details',
};
const questionOf = (code: string) =>
  engineQuestions[code] ??
  (code.startsWith('VALIDATION:options.')
    ? `option:${code.slice('VALIDATION:options.'.length)}`
    : undefined);

/** The profile axes each return reads without a default of the engine's own. */
function requiredAxes(form: ReturnForm, facts: readonly DerivedFact[], end: string): FactAxis[] {
  if (form === 'D300' || form === 'D394') return ['vat.status'];
  if (form === 'D406')
    return factAt(facts, 'vat.status', end) === 'non_vat'
      ? ['vat.status']
      : ['vat.status', 'vat.period'];
  return [];
}

export type ReturnReplayInput = Omit<ReplayInput, 'after'> & {
  /** Every filed D300, D394 and S1005 of the company, as `readFiledReturns` reads them. */
  returns: readonly FiledReturn[];
  /** The forms to rebuild; all four when absent. */
  forms?: readonly ReturnForm[];
  /** Which of ANAF's kits the engine was opened with, for the summary. */
  validators?: { general: boolean; saft: boolean };
};

type Engineered = { form: ReturnForm; period: string; xml: string };
type Question = { axis: string; form: ReturnForm; period: string; reason: string };
/** A return the run prepares, or the reason it prepares none. */
type Planned = {
  form: ReturnForm;
  period: string;
  months: { from: string; to: string };
  collapsed: string[];
} & (
  | { filed: FiledReturn }
  | { d406: ReplayPeriod }
  | { blocked: 'FILED_REFILINGS_AMBIGUOUS' | 'FILED_PERIOD_KIND' }
);
type ReturnResult = {
  form: ReturnForm;
  period: string;
  status: 'compared' | 'blocked';
  blocked?: { reason: BlockedReason; codes: string[] };
  /** The income and expense synthetics still holding a balance, for a year not closed. */
  yearEnd?: { unclosed: string[] };
  /** Transactions of the return's months the journal replay refused. */
  refusedTransactions?: number;
  /** The months hold the lab's opening, whose VAT balances the journal carried as CARRIED. */
  labOpening?: true;
  validation?: 'passed' | 'failed' | 'absent';
  validationCounts?: { errors: number; warnings: number; rules: Record<string, number> };
  differences?: {
    total: number;
    byClass: Record<string, number>;
    bySection: Record<string, number>;
    explainedByRefusal: number;
    unexplained: number;
  };
};

const count = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};
const sorted = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => order(a, b)));
const synthetics = (accounts: Iterable<string>) =>
  [...new Set([...accounts].flatMap((account) => syntheticAccount(account) ?? []))].sort(order);

/** The VAT accounts a refused transaction may have touched without naming a code. */
const vatAccounts = new Set(['4423', '4424', '4426', '4427', '4428']);
const touchesVat = (refusal: RefusedTransaction) =>
  refusal.taxes.some((tax) => tax.type === '300') ||
  refusal.accounts.some((account) => vatAccounts.has(syntheticAccount(account) ?? ''));

/** D300 elements by name: their printed row, and whether the writer computes them. */
const d300Elements = new Map<string, { row?: string; computed: boolean }>(
  d300Rows.map((row) => [row.element, { row: row.row, computed: row.computed }]),
);
/** S1005 cells by field name: their form and row. */
const s1005Cells = new Map<string, { form: string; row: string }>(
  Object.entries({
    F10: s1005F10Rows,
    F20: s1005F20Rows,
    F30: s1005F30Rows,
    F40: s1005F40Rows,
  }).flatMap(([form, rows]) =>
    rows.flatMap((spec) =>
      spec.columns.map(
        (column) => [`${form}_${spec.code}${column}`, { form, row: spec.row }] as const,
      ),
    ),
  ),
);
const formulas = new Map(
  s1005Formulas.map((formula) => [`${formula.form}.${formula.row}`, formula]),
);

/**
 * The refused transactions of the journal replay a return field depends on, by the tax codes or
 * accounts the field is computed from. D300 rows by the rows each refused VAT code's readings
 * quote (a code without a reading, or VAT lines without one, may touch any row), the writer's
 * totals and the header by every refused VAT transaction of the period; D394 by every refused VAT
 * transaction of the period; S1005 cells by the accounts of their row's formula, the balance sheet
 * by refusals up to the year's end, the rest of the statement by the year's.
 */
export function explainingRefusals(
  form: ReturnForm,
  period: string,
  field: string,
  refused: readonly RefusedTransaction[],
): RefusedTransaction[] {
  const months = periodMonths(period);
  const within = refused.filter((item) => item.month >= months.from && item.month <= months.to);
  const attribute = /\/@([^/]+)$/.exec(field)?.[1];
  if (form === 'D300' || form === 'D394') {
    const vat = within.filter(touchesVat);
    if (form === 'D394' || !attribute) return vat;
    const element = d300Elements.get(attribute);
    if (!element?.row || element.computed) return vat;
    return vat.filter((item) => {
      const codes = item.taxes.filter((tax) => tax.type === '300');
      if (!codes.length) return true;
      return codes.some((tax) => {
        const readings = d406CodeReadings(tax.code);
        return (
          !readings.length ||
          readings.some(
            (reading) =>
              !('d300' in reading) ||
              reading.d300
                .split('/')
                .map((part) => part.trim())
                .includes(element.row!),
          )
        );
      });
    });
  }
  if (form === 'S1005') {
    const cell = attribute ? s1005Cells.get(attribute) : undefined;
    const pool = cell?.form === 'F10' ? refused.filter((item) => item.month <= months.to) : within;
    const formula = cell ? formulas.get(`${cell.form}.${cell.row}`) : undefined;
    if (!formula)
      return pool.filter((item) => item.accounts.some((account) => /^[1-7]/.test(account)));
    // An engine account reads under a term by its synthetic, or by an analytic that repeats the
    // synthetic's subdivision (605.6051 under 6051).
    return pool.filter((item) =>
      item.accounts.some((account) => {
        const [synthetic, ...rest] = account.split('.');
        return formula.terms.some(
          (term) =>
            synthetic!.startsWith(term.account) ||
            rest.some((part) => part.startsWith(synthetic!) && part.startsWith(term.account)),
        );
      }),
    );
  }
  return within;
}

/**
 * Rebuilds a company's filed returns from its replayed journal. The journal replay runs first,
 * with the register the engine uses in production; then, before the engine closes, the profile
 * facts the filed files state are recorded with those files as evidence, and each filed D300,
 * D394, D406 and S1005 of the replayed months is prepared by the engine for the same period, with
 * the options its filed return states, validated by ANAF's validator when installed, and compared
 * field by field with the filed one. Every difference, every return the engine could not prepare
 * and every validator refusal is reconciled in the replay's store, one scope per return.
 */
export async function replayReturns(input: ReturnReplayInput) {
  const forms = input.forms ?? returnForms;
  let outcome: Awaited<ReturnType<typeof prepareReturns>> | undefined;
  const journal = await replayCompany({
    ...input,
    after: async (session) => {
      outcome = await prepareReturns(input, forms, session);
    },
  });
  if (journal.status === 'blocked' || !outcome)
    return {
      status: 'blocked' as const,
      summary: { company: input.alias, status: 'blocked', journal: journal.summary },
      manifest: { journal: journal.manifest },
      prepared: [] as Engineered[],
    };
  const { summary, manifest, prepared } = outcome;
  const journalSummary = journal.summary as {
    periods: unknown;
    transactions: unknown;
    opening: unknown;
    differences: unknown;
  };
  return {
    status: 'completed' as const,
    summary: {
      company: input.alias,
      status: 'completed',
      journal: {
        periods: journalSummary.periods,
        opening: journalSummary.opening,
        transactions: journalSummary.transactions,
        differences: journalSummary.differences,
      },
      ...summary,
    },
    manifest: { ...manifest, journal: journal.manifest },
    prepared,
  };
}

async function prepareReturns(
  input: ReturnReplayInput,
  forms: readonly ReturnForm[],
  session: ReplaySession,
) {
  const { invoke, periods } = session;
  const replayed = {
    from: periods[0]!.start.slice(0, 7),
    to: periods.at(-1)!.end.slice(0, 7),
  };
  const inReplay = input.returns.filter(
    (item) => item.months.from >= replayed.from && item.months.to <= replayed.to,
  );

  // The filed files as evidence: the D406 the journal recorded, and the other returns now.
  const evidence = new Map<string, string>();
  for (const period of periods)
    evidence.set(period.filing.sha256, session.evidence.get(period.period)!);
  for (const item of inReplay)
    if (!evidence.has(item.sha256)) {
      const recorded = await invoke<{ id: string }>('evidence.record', {
        filename: `${item.form}-${item.period ?? item.months.to}.xml`,
        mediaType: 'application/xml',
        base64: Buffer.from(item.xml).toString('base64'),
      });
      evidence.set(item.sha256, recorded.id);
    }

  // The profile facts the filed files state, each with the file as its evidence.
  const { facts: derived, conflicts } = deriveFacts(factStatements(periods, inReplay));
  const facts: DerivedFact[] = [];
  const refusedFacts: (DerivedFact & { code: string })[] = [];
  for (const fact of derived)
    try {
      await invoke('profile.record', {
        axis: fact.axis,
        value: fact.value,
        effectiveFrom: fact.effectiveFrom,
        evidenceId: evidence.get(fact.evidence.sha256)!,
      });
      facts.push(fact);
    } catch (error) {
      refusedFacts.push({ ...fact, code: wireError(error).error.code });
    }
  const cui = session.view.company.replace(/^RO/i, '');
  const seller = sellerOf(periods[0]!.filing.filed, cui);
  let sellerRecorded: 'recorded' | string = 'SELLER_NOT_STATED';
  if (seller)
    try {
      await invoke('sales.seller.record', { details: seller });
      sellerRecorded = 'recorded';
    } catch (error) {
      sellerRecorded = wireError(error).error.code;
    }

  // The partners' names and addresses, as the latest replayed D406 master files state them.
  const partners = { recorded: 0, notStated: 0, refused: {} as Record<string, number> };
  const latest = new Map<string, D406FiledParty>();
  for (const { filing } of periods)
    for (const [role, list] of [
      ['customer', filing.filed.masterFiles.customers],
      ['supplier', filing.filed.masterFiles.suppliers],
    ] as const)
      for (const record of list) {
        const key = record.id
          ? session.view.partyOf({ origin: 'd406', role, id: record.id })
          : undefined;
        if (key) latest.set(key, record);
      }
  for (const { key, party } of session.view.parties) {
    const partyId = session.partyIds.get(key);
    const record = latest.get(key);
    if (!partyId || !record) continue;
    const details = partnerOf(record, party);
    if (!details) {
      partners.notStated++;
      continue;
    }
    try {
      await invoke('parties.recordDetails', { partyId, details });
      partners.recorded++;
    } catch (error) {
      count(partners.refused, wireError(error).error.code);
    }
  }

  // The returns: the filed D300, D394 and S1005 of the replayed months, and every replayed D406.
  const declarationForms = forms.filter((form) => form !== 'D406');
  const { selected, outsideReplay } = selectReturns(input.returns, declarationForms, replayed);
  const planned: Planned[] = [...selected];
  if (forms.includes('D406'))
    for (const period of periods) {
      const months = { from: period.start.slice(0, 7), to: period.end.slice(0, 7) };
      const engine = d406Period(period.start, period.end);
      planned.push(
        engine
          ? { form: 'D406', period: engine, months, collapsed: [], d406: period }
          : {
              form: 'D406',
              period: period.period,
              months,
              collapsed: [],
              blocked: 'FILED_PERIOD_KIND',
            },
      );
    }
  const formOrder = (form: string) => returnForms.indexOf(form as ReturnForm);
  planned.sort((a, b) => order(a.months.to, b.months.to) || formOrder(a.form) - formOrder(b.form));

  const questions: Question[] = [];
  for (const conflict of conflicts) questions.push(...conflictQuestions(conflict, planned));
  if (sellerRecorded !== 'recorded')
    for (const item of planned)
      questions.push({
        axis: 'seller.details',
        form: item.form,
        period: item.period,
        reason: sellerRecorded,
      });

  const results: ReturnResult[] = [];
  const prepared: Engineered[] = [];
  const recorded: Record<string, unknown>[] = [];
  const reconciled: Difference[] = [];
  const causes: readonly Cause[] = input.causes ?? [];
  const openingMonth = session.opening.date.slice(0, 7);
  for (const item of planned) {
    const scope = `returns:${item.form}:${item.period}`;
    const subject = `return:${item.form}`;
    const period = storePeriod(item.months);
    const blockedDifference = (reason: BlockedReason, codes: string[], detail: unknown) => {
      const cause = causeOfBlock[reason];
      return withContext(
        difference({
          kind: 'return-blocked',
          period,
          locator: { subject },
          source: null,
          engine: json({ reason, codes, detail }),
        }),
        cause ? { cause: { class: cause.class, reason } } : {},
      );
    };
    // The journal's refusals of the return's months, and whether they hold the lab's opening.
    const refusedHere = session.refused.filter(
      (refusal) => refusal.month >= item.months.from && refusal.month <= item.months.to,
    ).length;
    const labOpening =
      item.form === 'D406' &&
      item.months.from <= openingMonth &&
      openingMonth <= item.months.to &&
      session.opening.treatment === 'migration.journal';
    const finish = async (result: ReturnResult, differences: Difference[]) => {
      results.push({
        ...result,
        refusedTransactions: refusedHere,
        ...(labOpening ? { labOpening } : {}),
      });
      reconciled.push(
        ...(await input.store.reconcile(scope, differences, causes)).filter(
          (stored) => stored.scope === scope,
        ),
      );
    };
    if ('blocked' in item) {
      await finish(
        {
          form: item.form,
          period: item.period,
          status: 'blocked',
          blocked: { reason: item.blocked, codes: [] },
        },
        [blockedDifference(item.blocked, [], { collapsed: item.collapsed.length })],
      );
      continue;
    }
    const end = monthEnd(item.months.to);
    const missing = requiredAxes(item.form, facts, end).filter(
      (axis) => factAt(facts, axis, end) === undefined,
    );
    for (const axis of missing)
      if (
        !questions.some(
          (question) =>
            question.axis === axis &&
            question.form === item.form &&
            question.period === item.period,
        )
      )
        questions.push({ axis, form: item.form, period: item.period, reason: 'NO_EVIDENCE' });
    const options = !('filed' in item)
      ? d406OptionsOf(item.d406.filing.filed, session.view.engineAccount)
      : item.form === 'D300'
        ? d300OptionsOf(item.filed.declaration)
        : item.form === 'D394'
          ? d394OptionsOf(item.filed.declaration)
          : s1005OptionsOf(item.filed.declaration);
    let view: {
      id: string;
      state: string;
      xmlHash: string;
      steps: { state: string; detail: string | null }[];
    };
    try {
      view = await invoke('declarations.prepare', {
        kind: item.form,
        period: item.period,
        options,
      });
    } catch (error) {
      const wire = wireError(error).error;
      const details = wire.details as
        { problems?: { code: string; message: string }[] } | { path: string }[] | undefined;
      const problems = Array.isArray(details)
        ? details.map((issue) => ({ code: `${wire.code}:${issue.path}`, message: '' }))
        : (details?.problems ?? [{ code: wire.code, message: wire.message }]);
      const codes = [...new Set(problems.map((problem) => problem.code))].sort(order);
      const reason: BlockedReason =
        wire.code === 'FORMAT_GAP'
          ? 'FORMAT_GAP'
          : missing.length || sellerRecorded !== 'recorded'
            ? 'FACT_MISSING'
            : labOpening
              ? 'LAB_OPENING'
              : item.form === 'S1005' && codes.includes('S1005_NOT_CLOSED')
                ? 'YEAR_NOT_CLOSED'
                : item.form === 'S1005' && codes.includes('S1005_RESULT')
                  ? 'CLOSING_JOURNAL'
                  : 'ENGINE_PROBLEMS';
      for (const code of codes) {
        const axis = questionOf(code);
        if (
          axis &&
          !questions.some(
            (question) =>
              question.axis === axis &&
              question.form === item.form &&
              question.period === item.period,
          )
        )
          questions.push({
            axis,
            form: item.form,
            period: item.period,
            reason: `ENGINE_ASKS:${code}`,
          });
      }
      const yearEnd =
        reason === 'YEAR_NOT_CLOSED' ? await unclosedAccounts(session, item.period) : undefined;
      await finish(
        {
          form: item.form,
          period: item.period,
          status: 'blocked',
          blocked: { reason, codes },
          ...(yearEnd ? { yearEnd } : {}),
        },
        [blockedDifference(reason, codes, { problems, ...(yearEnd ? { yearEnd } : {}) })],
      );
      recorded.push({
        form: item.form,
        period: item.period,
        options,
        blocked: { reason, problems },
      });
      continue;
    }

    // ANAF's validator ran in `prepare` when installed.
    const validation: ReturnResult['validation'] =
      view.state === 'validated_official'
        ? 'passed'
        : view.state === 'validation_failed'
          ? 'failed'
          : 'absent';
    const messages =
      validation === 'failed'
        ? (view.steps.find((step) => step.state === 'validation_failed')?.detail ?? '')
            .split('\n')
            .filter(Boolean)
        : [];
    const validationCounts = validation === 'failed' ? countMessages(messages) : undefined;
    const xml = new TextDecoder().decode(
      await session.books.objects.get(session.companyId, view.xmlHash),
    );
    prepared.push({ form: item.form, period: item.period, xml });
    const differences: Difference[] = [];
    if (validation === 'failed')
      differences.push(
        difference({
          kind: 'return-validation',
          period,
          locator: { subject, field: 'validation' },
          source: null,
          engine: { messages },
        }),
      );

    // The comparison, field by field.
    let compared: ReturnDifference[] = [];
    let refusedComparison: string | undefined;
    if (!('filed' in item)) refusedComparison = 'RETURN_CATALOGUE';
    else
      try {
        const engine = readDeclaration(new TextEncoder().encode(xml));
        compared = compareReturns(
          engine,
          item.filed.declaration,
          catalogueFor(item.filed.declaration),
        );
      } catch (error) {
        refusedComparison =
          error instanceof ReturnComparisonError
            ? error.code
            : error instanceof Error && error.message.startsWith('RETURN_CATALOGUE:')
              ? 'RETURN_CATALOGUE'
              : 'RETURN_READ';
      }
    if (refusedComparison) {
      differences.push(blockedDifference('COMPARISON_REFUSED', [refusedComparison], undefined));
      await finish(
        {
          form: item.form,
          period: item.period,
          status: 'blocked',
          blocked: { reason: 'COMPARISON_REFUSED', codes: [refusedComparison] },
          validation,
          ...(validationCounts ? { validationCounts } : {}),
        },
        differences,
      );
      recorded.push({
        form: item.form,
        period: item.period,
        options,
        artifact: view.id,
        validation,
      });
      continue;
    }
    const byClass: Record<string, number> = Object.fromEntries(
      differenceClasses.map((name) => [name, 0]),
    );
    const bySection: Record<string, number> = {};
    let explained = 0;
    for (const found of compared) {
      byClass[found.class]!++;
      count(bySection, found.section);
      const refusals = explainingRefusals(item.form, item.period, found.path, session.refused);
      if (refusals.length) explained++;
      differences.push(
        withContext(
          difference({
            kind: `return-${found.class}` as Observation['kind'],
            period,
            locator: { subject, field: found.path },
            source: json(found.filed),
            engine: json(found.engine),
            ...(found.class === 'amount' || found.class === 'rounding'
              ? { delta: found.delta }
              : {}),
            accounts: [...new Set(refusals.flatMap((refusal) => refusal.accounts))],
            taxCodes: [
              ...new Set(
                refusals.flatMap((refusal) =>
                  refusal.taxes.filter((tax) => tax.type === '300').map((tax) => tax.code),
                ),
              ),
            ],
          }),
          {
            ...(refusals.length ? refusalContext(refusals) : {}),
            ...(found.class === 'cosmetic'
              ? { cause: { class: 'comparator' as const, reason: 'COSMETIC' } }
              : found.class === 'zero-omission'
                ? { cause: { class: 'comparator' as const, reason: 'ZERO_OMISSION' } }
                : {}),
          },
        ),
      );
    }
    await finish(
      {
        form: item.form,
        period: item.period,
        status: 'compared',
        validation,
        ...(validationCounts ? { validationCounts } : {}),
        differences: {
          total: compared.length,
          byClass,
          bySection: sorted(bySection),
          explainedByRefusal: explained,
          unexplained: compared.length - explained,
        },
      },
      differences,
    );
    recorded.push({
      form: item.form,
      period: item.period,
      options,
      artifact: view.id,
      validation,
      messages,
    });
  }

  return {
    summary: summaryOf(input, session, {
      results,
      reconciled,
      facts,
      refusedFacts,
      conflicts,
      questions,
      sellerRecorded,
      partners,
      selected: planned.length,
      outsideReplay,
      collapsed: selected.reduce((sum, item) => sum + item.collapsed.length, 0),
    }),
    manifest: {
      facts: facts.map((fact) => ({ ...fact, evidenceId: evidence.get(fact.evidence.sha256) })),
      refusedFacts,
      seller: seller
        ? {
            recorded: sellerRecorded,
            evidence: {
              form: 'D406',
              period: periods[0]!.period,
              sha256: periods[0]!.filing.sha256,
            },
          }
        : null,
      returns: recorded,
      filed: selected.map((item) => ({
        form: item.form,
        period: item.period,
        ...('filed' in item ? { sha256: item.filed.sha256 } : { blocked: item.blocked }),
        collapsed: item.collapsed,
      })),
    },
    prepared,
  };
}

/** The D406 period of a replayed interval: a month or a calendar quarter, null otherwise. */
function d406Period(start: string, end: string): string | null {
  const from = start.slice(0, 7);
  const to = end.slice(0, 7);
  if (!start.endsWith('-01') || end !== monthEnd(to)) return null;
  if (from === to) return from;
  const month = Number(to.slice(5, 7));
  if (month % 3 !== 0) return null;
  const quarter = `${to.slice(0, 4)}-Q${month / 3}`;
  return periodMonths(quarter).from === from ? quarter : null;
}

/** The returns an axis's conflicting files stop, each a question. */
function conflictQuestions(
  conflict: FactConflict,
  planned: readonly { form: ReturnForm; period: string }[],
): Question[] {
  return planned
    .filter((item) => {
      const months = periodMonths(item.period);
      return months.from <= conflict.to.slice(0, 7) && conflict.from.slice(0, 7) <= months.to;
    })
    .map((item) => ({
      axis: conflict.axis,
      form: item.form,
      period: item.period,
      reason: conflict.reason,
    }));
}

/** A finding a refused transaction explains: the most frequent refusal, and every reason. */
function refusalContext(
  refusals: readonly RefusedTransaction[],
): NonNullable<Observation['context']> {
  const reasons: Record<string, number> = {};
  for (const refusal of refusals) count(reasons, refusal.reason);
  const [reason] = Object.entries(reasons).sort(([a, x], [b, y]) => y - x || order(a, b))[0]!;
  const at = reason.indexOf(':');
  const stage = reason.slice(0, at) as NonNullable<
    NonNullable<Observation['context']>['refusal']
  >['stage'];
  return {
    refusal: {
      stage,
      code: reason.slice(at + 1),
      message: `${refusals.length} refused transaction(s) of the journal replay touch the codes or accounts this field is computed from.`,
      issues: Object.keys(reasons).sort(order),
    },
  };
}

/** Errors (E:) and warnings (A:) of ANAF's validator, and how many of its lines name each rule
 * (`eroare regula: R16: …`); the lines themselves may quote the return's values. */
export function countMessages(messages: readonly string[]) {
  const rules: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const message of messages) {
    if (/^\s*E\s*:/.test(message)) errors++;
    else if (/^\s*A\s*:/.test(message)) warnings++;
    const rule = /\b(R\d+(?:\.\d+)*)\b/.exec(message)?.[1];
    if (rule) count(rules, rule);
  }
  return { errors, warnings, rules: sorted(rules) };
}

/** The income and expense synthetics with a balance at the year's end: what closing the year
 * as the engine closes it would still move. */
async function unclosedAccounts(session: ReplaySession, year: string) {
  const years = await session.invoke<{ items: { id: string; kind: string; from: string }[] }>(
    'years.list',
    {},
  );
  const financial = years.items.find(
    (item) => item.kind === 'financial' && item.from === `${year}-01-01`,
  );
  if (!financial) return { unclosed: [] as string[] };
  const balance = await session.invoke<{
    rows: { account: string; closing: { debit: string; credit: string } }[];
  }>('ledger.trialBalance', { financialYearId: financial.id });
  const unclosed = balance.rows.filter(
    (row) =>
      /^[67]/.test(row.account) &&
      subtract(decimal(row.closing.debit)!, decimal(row.closing.credit)!).units !== 0n,
  );
  return { unclosed: synthetics(unclosed.map((row) => row.account)) };
}

/** A value as the store keeps it: JSON, absent fields dropped. */
const json = (value: unknown): Observation['engine'] =>
  value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Observation['engine']);

function withContext(item: Difference, context: NonNullable<Observation['context']>): Difference {
  return Object.keys(context).length ? { ...item, context } : item;
}

function summaryOf(
  input: ReturnReplayInput,
  session: ReplaySession,
  run: {
    results: ReturnResult[];
    reconciled: Difference[];
    facts: DerivedFact[];
    refusedFacts: (DerivedFact & { code: string })[];
    conflicts: FactConflict[];
    questions: Question[];
    sellerRecorded: string;
    partners: { recorded: number; notStated: number; refused: Record<string, number> };
    selected: number;
    outsideReplay: number;
    collapsed: number;
  },
) {
  const register = session.books.engine.register;
  const statuses: Record<string, number> = {};
  for (const version of register.versions) count(statuses, version.status);
  const byForm: Record<string, unknown> = {};
  for (const form of returnForms) {
    const own = run.results.filter((item) => item.form === form);
    if (!own.length) continue;
    const blocked: Record<string, number> = {};
    const blockedCodes: Record<string, number> = {};
    const validation = { passed: 0, failed: 0, absent: 0 };
    const rules: Record<string, number> = {};
    const differences = {
      total: 0,
      byClass: Object.fromEntries(differenceClasses.map((name) => [name, 0])) as Record<
        string,
        number
      >,
      bySection: {} as Record<string, number>,
      explainedByRefusal: 0,
      unexplained: 0,
    };
    for (const item of own) {
      if (item.blocked) {
        count(blocked, item.blocked.reason);
        for (const code of item.blocked.codes) count(blockedCodes, code);
      }
      if (item.validation) validation[item.validation]++;
      for (const [rule, n] of Object.entries(item.validationCounts?.rules ?? {}))
        count(rules, rule, n);
      if (!item.differences) continue;
      differences.total += item.differences.total;
      for (const [name, n] of Object.entries(item.differences.byClass))
        count(differences.byClass, name, n);
      for (const [name, n] of Object.entries(item.differences.bySection))
        count(differences.bySection, name, n);
      differences.explainedByRefusal += item.differences.explainedByRefusal;
      differences.unexplained += item.differences.unexplained;
    }
    byForm[form] = {
      selected: own.length,
      prepared: own.filter((item) => item.validation !== undefined).length,
      compared: own.filter((item) => item.status === 'compared').length,
      blocked: sorted(blocked),
      blockedCodes: sorted(blockedCodes),
      validation,
      validationRules: sorted(rules),
      differences: { ...differences, bySection: sorted(differences.bySection) },
    };
  }
  const open = run.reconciled.filter((item) => item.status === 'open');
  const byClass = Object.fromEntries(classes.map((name) => [name, 0])) as Record<
    DifferenceClass,
    number
  >;
  const byKind: Record<string, number> = {};
  for (const item of open) {
    byClass[item.class]++;
    count(byKind, item.kind);
  }
  const questions = new Map<
    string,
    { axis: string; reason: string; forms: Set<string>; periods: Set<string> }
  >();
  for (const question of run.questions) {
    const key = `${question.axis}|${question.reason}`;
    const entry = questions.get(key) ?? {
      axis: question.axis,
      reason: question.reason,
      forms: new Set(),
      periods: new Set(),
    };
    entry.forms.add(question.form);
    entry.periods.add(question.period);
    questions.set(key, entry);
  }
  const recorded: Record<string, number> = {};
  for (const fact of run.facts) count(recorded, fact.axis);
  const evidenceKinds: Record<string, number> = {};
  for (const fact of run.facts) count(evidenceKinds, `${fact.axis}:${fact.reason}`);
  return {
    register: { versions: register.versions.length, byStatus: sorted(statuses) },
    validators: input.validators ?? { general: false, saft: false },
    facts: {
      recorded: sorted(recorded),
      byEvidence: sorted(evidenceKinds),
      refused: sorted(
        run.refusedFacts.reduce<Record<string, number>>((counts, fact) => {
          count(counts, `${fact.axis}:${fact.code}`);
          return counts;
        }, {}),
      ),
      conflicts: run.conflicts.map(({ axis, from, to }) => ({ axis, from, to })),
      seller: run.sellerRecorded,
      partners: { ...run.partners, refused: sorted(run.partners.refused) },
      questions: [...questions.values()]
        .map((entry) => ({
          axis: entry.axis,
          reason: entry.reason,
          forms: [...entry.forms].sort(order),
          periods: [...entry.periods].sort(order),
        }))
        .sort((a, b) => order(a.axis, b.axis) || order(a.reason, b.reason)),
    },
    returns: {
      selected: run.selected,
      outsideReplay: run.outsideReplay,
      refilingsCollapsed: run.collapsed,
      byForm,
      list: run.results,
    },
    refusedTransactions: session.refused.length,
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
}
