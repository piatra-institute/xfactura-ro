import type { Issue } from '../../kernel';
import { allocate, formatMoney } from '../../money';
import { addDays, type LocalDate } from '../../time';
import { natureOf, type LimitKey, type NatureCode } from './natures';
import type { SourcesRule } from './parameters';

/**
 * Several sources of independent income of one person in a year, and a change of how a source's
 * net income is set within it. The Registrul de evidență fiscală is kept per source (OMFP nr.
 * 3.254/2017 art. 3 alin. (3)–(4)): gross income and deductible expenses are recorded per source
 * (art. 4 alin. (1), art. 5 alin. (1)). Each receipt, payment and non-cash item is the source's
 * whose account it is booked on (the person's attribution, by account and its analytics, the
 * longest match winning); an expense serving several sources is split by the key the person
 * states (`ro.pit.sources` lists the admitted keys: no text sets one). A source that moves from a
 * norm to the real system within the year (norme pct. 8 alin. (13): another activity outside the
 * nomenclator added) has its norm for the days before the change and its books from that day;
 * the net income is their sum.
 */

const block = (code: string, message: string): Issue => ({ code, severity: 'block', message });
const info = (code: string, message: string): Issue => ({ code, severity: 'info', message });
const lei = (bani: bigint) => formatMoney(bani < 0n ? -bani : bani, 'RON');

export type Method = 'sistem_real' | 'norma';

/** A period of the year in which a source's net income is set one way, both days included. */
export interface Segment {
  method: Method;
  from: LocalDate;
  to: LocalDate;
}

/** A source's versions as dated methods: `{ effectiveFrom, method }`, oldest first. */
export function segmentsOf(
  versions: readonly { effectiveFrom: string; method: Method; startedOn: string }[],
  year: number,
): Segment[] {
  const start = `${year}-01-01` as LocalDate;
  const end = `${year}-12-31` as LocalDate;
  const opening = versions.filter((row) => row.effectiveFrom <= start).at(-1);
  const points = [
    ...(opening ? [opening] : []),
    ...versions.filter((row) => row.effectiveFrom > start && row.effectiveFrom <= end),
  ];
  const segments: Segment[] = [];
  for (const row of points) {
    const from = (row.effectiveFrom > start ? row.effectiveFrom : start) as LocalDate;
    const last = segments.at(-1);
    if (last?.method === row.method) continue;
    if (last) last.to = addDays(from, -1);
    segments.push({ method: row.method, from, to: end });
  }
  return segments;
}

export interface SourcePart {
  nature: NatureCode;
  /** The account the nature was read from (with its analytics). */
  account: string;
  /** Money in positive, money out negative. */
  flow: bigint;
  /** The receipt's or payment's date; null for a non-cash item of the whole year. */
  date: LocalDate | null;
  label?: string;
  /** Set when the item names its source itself (an adjustment). */
  sourceId?: string;
}

export type SharedKey =
  { kind: 'gross' } | { kind: 'fixed'; shares: readonly { sourceId: string; percent: string }[] };

export interface Attribution {
  /** The account (with analytics) each source's receipts and payments are booked on. */
  accounts: readonly { match: string; sourceId: string }[];
  /** Accounts whose amounts serve several sources, and the key the person states for them. */
  shared: readonly { match: string; key: SharedKey }[];
}

export interface AttributedSource {
  sourceId: string;
  /** The real system's parts (receipts and payments in its real-system days, non-cash items). */
  parts: SourcePart[];
  /** Gross income received in the days on a norm: the income part of the register. */
  normGross: bigint;
  /** What the shared accounts gave it. */
  shared: { account: string; bani: bigint }[];
}

const kindOf = (nature: NatureCode) => natureOf(nature)?.kind;
/** The natures the register reads: income, expenses, and what it lists as excluded. */
const counted = (nature: NatureCode) =>
  ['income', 'expense', 'limited', 'excluded', 'asset'].includes(kindOf(nature) ?? '');
/** The per-person euro limits (art. 68 alin. (5) lit. g)–h), p), r), s)): one person, one limit. */
const euroLimits: readonly LimitKey[] = [
  'association',
  'pension',
  'occupationalPension',
  'pepp',
  'health',
  'sport',
  'etf',
];

/** The rule an account matches: the longest, an attribution to one source before a shared one. */
function ruleOf(attribution: Attribution, account: string) {
  const matches = (match: string) =>
    account === match || account.startsWith(match.includes('.') ? `${match}.` : match);
  const candidates = [
    ...attribution.accounts
      .filter((rule) => matches(rule.match))
      .map((rule) => ({ length: rule.match.length, sourceId: rule.sourceId, key: null })),
    ...attribution.shared
      .filter((rule) => matches(rule.match))
      .map((rule) => ({ length: rule.match.length - 0.5, sourceId: null, key: rule.key })),
  ].sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

const within = (date: LocalDate | null, segment: Segment) =>
  date !== null && date >= segment.from && date <= segment.to;

/**
 * Splits a year's receipts, payments and non-cash items among the person's sources. With one
 * source, everything is its own. Each source's days on a norm take only their gross income (the
 * norm's register part, norme pct. 8 alin. (13)); its days in the real system take the rest. An
 * amount no rule places, of an income or expense nature, blocks: the register cannot be kept per
 * source without it.
 */
export function attributeSources(input: {
  parts: readonly SourcePart[];
  sources: readonly { sourceId: string; name: string; segments: readonly Segment[] }[];
  attribution: Attribution | null;
  rule: SourcesRule | null;
}): { sources: AttributedSource[]; excluded: SourcePart[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const result = new Map(
    input.sources.map((source) => [
      source.sourceId,
      { sourceId: source.sourceId, parts: [], normGross: 0n, shared: [] } as AttributedSource,
    ]),
  );
  const segments = new Map(input.sources.map((source) => [source.sourceId, source.segments]));
  const real = input.sources.filter((source) =>
    source.segments.some((segment) => segment.method === 'sistem_real'),
  );
  const excluded: SourcePart[] = [];
  const unplaced = new Map<string, bigint>();
  const sharedParts: { part: SourcePart; key: SharedKey }[] = [];
  const single = input.sources.length === 1 ? input.sources[0]!.sourceId : null;

  const place = (sourceId: string, part: SourcePart) => {
    const own = result.get(sourceId)!;
    const norm = segments.get(sourceId)!.find((segment) => segment.method === 'norma');
    const inNorm = norm && within(part.date, norm);
    if (inNorm || !segments.get(sourceId)!.some((segment) => segment.method === 'sistem_real')) {
      // Under a norm only receipts count, for the income part of the register and the 25.000
      // euro threshold; expenses do not reduce a norm.
      if (kindOf(part.nature) === 'income') own.normGross += part.flow;
      return;
    }
    own.parts.push(part);
  };

  for (const part of input.parts) {
    if (!natureOf(part.nature)) {
      issues.push(
        block(
          'PIT_NATURE_MISSING',
          `Încasări și plăți de ${lei(part.flow)} lei nu au o natură (${part.nature}): clasificați-le înainte de a stabili venitul net.`,
        ),
      );
      continue;
    }
    if (!counted(part.nature)) continue;
    if (part.sourceId && result.has(part.sourceId)) {
      place(part.sourceId, part);
      continue;
    }
    if (single) {
      place(single, part);
      continue;
    }
    const rule = input.attribution ? ruleOf(input.attribution, part.account) : null;
    if (rule?.sourceId && result.has(rule.sourceId)) place(rule.sourceId, part);
    else if (rule?.key) sharedParts.push({ part, key: rule.key });
    else if (['excluded', 'asset'].includes(kindOf(part.nature)!)) excluded.push(part);
    else unplaced.set(part.account, (unplaced.get(part.account) ?? 0n) + part.flow);
  }
  if (unplaced.size)
    issues.push(
      block(
        'PIT_SOURCE_UNATTRIBUTED',
        `Mai multe surse de venit în același an: ${[...unplaced].map(([account, bani]) => `${account} (${lei(bani)} lei)`).join(', ')} nu sunt atribuite unei surse; indicați sursa fiecărui cont (attribution.accounts) sau cheia de repartizare a cheltuielilor comune (attribution.shared), cu documentul ei (OMFP nr. 3.254/2017 art. 3–5).`,
      ),
    );

  // Shared amounts: split among the sources in the real system, by the key stated.
  const gross = new Map(
    real.map((source) => [
      source.sourceId,
      result
        .get(source.sourceId)!
        .parts.filter((part) => kindOf(part.nature) === 'income')
        .reduce((sum, part) => sum + part.flow, 0n),
    ]),
  );
  for (const { part, key } of sharedParts) {
    if (!input.rule || !input.rule.sharedKeys.includes(key.kind)) {
      issues.push(
        block(
          'PIT_SHARED_KEY',
          `Cheia „${key.kind}” pentru cheltuielile comune de pe ${part.account} nu este admisă în registrul de reguli (ro.pit.sources).`,
        ),
      );
      continue;
    }
    let weights: { sourceId: string; weight: bigint }[];
    if (key.kind === 'gross')
      weights = real.map((source) => ({
        sourceId: source.sourceId,
        weight: (gross.get(source.sourceId) ?? 0n) > 0n ? gross.get(source.sourceId)! : 0n,
      }));
    else {
      const total = key.shares.reduce((sum, share) => sum + Number(share.percent) * 100, 0);
      const unknown = key.shares.filter(
        (share) => !real.some((source) => source.sourceId === share.sourceId),
      );
      if (Math.round(total) !== 10_000 || unknown.length) {
        issues.push(
          block(
            'PIT_SHARED_KEY',
            `Cheia de repartizare a cheltuielilor de pe ${part.account} are cote de ${(total / 100).toFixed(2)}%${unknown.length ? ' și surse care nu sunt în sistem real în acest an' : ''}: cotele surselor în sistem real însumează 100%.`,
          ),
        );
        continue;
      }
      weights = key.shares.map((share) => ({
        sourceId: share.sourceId,
        weight: BigInt(Math.round(Number(share.percent) * 100)),
      }));
    }
    if (!weights.some((item) => item.weight > 0n)) {
      issues.push(
        block(
          'PIT_SHARED_KEY',
          `Cheltuielile comune de pe ${part.account} se repartizează după venitul brut, dar nicio sursă în sistem real nu are venit brut.`,
        ),
      );
      continue;
    }
    const split = allocate(
      part.flow,
      weights.map((item) => item.weight),
    );
    weights.forEach((item, index) => {
      const bani = split[index]!;
      if (bani === 0n) return;
      const own = result.get(item.sourceId)!;
      own.parts.push({ ...part, flow: bani, sourceId: item.sourceId });
      own.shared.push({ account: part.account, bani });
    });
  }
  if (sharedParts.length)
    issues.push(
      info(
        'PIT_SHARED_EXPENSE',
        'Cheltuielile comune mai multor surse sunt repartizate după cheia indicată de persoană; niciun text nu stabilește cheia (întrebare pentru expertul contabil, ro.pit.sources).',
      ),
    );

  // A per-person euro limit claimed in several sources would be counted once per source.
  for (const limit of euroLimits) {
    const holders = [...result.values()].filter((source) =>
      source.parts.some((part) => natureOf(part.nature)?.limit === limit),
    );
    if (holders.length > 1)
      issues.push(
        block(
          'PIT_LIMIT_SOURCES',
          `Cheltuieli deductibile limitat la o sumă în euro pe persoană (${limit}) apar la mai multe surse: limita de la art. 68 alin. (5) este a persoanei, pe an; atribuiți-le unei singure surse.`,
        ),
      );
  }
  return { sources: [...result.values()], excluded, issues };
}

/** Days of a period, both ends included. */
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
