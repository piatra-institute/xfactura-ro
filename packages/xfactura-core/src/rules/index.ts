import type { ZodType } from 'zod';
import { canonical, hashOf } from '../hash';
import type { JsonValue } from '../kernel';
import type { LocalDate } from '../time';

/** Review ladder for a parameter version. Only an independent expert contabil signs. */
export type ReviewStatus = 'extracted' | 'interpreted' | 'cases_approved' | 'signed';
const rank: Record<ReviewStatus, number> = {
  extracted: 0,
  interpreted: 1,
  cases_approved: 2,
  signed: 3,
};

/** What a resolved value will be used for, and the least review that use requires. */
export type UseMode = 'preview' | 'shadow' | 'posting' | 'filing';
export const requiredStatus: Record<UseMode, ReviewStatus> = {
  preview: 'extracted',
  shadow: 'interpreted',
  posting: 'signed',
  filing: 'signed',
};

/** The date that selects a parameter's version. Each parameter has exactly one. */
export type DateAxis =
  | 'vat_chargeability_date'
  | 'supply_date'
  | 'invoice_issue_date'
  | 'payment_date'
  | 'accounting_transaction_date'
  | 'reporting_period_start'
  | 'fiscal_year_start'
  | 'payroll_month_start'
  | 'dividend_payment_date'
  | 'distribution_decision_date'
  | 'submission_date'
  | 'asset_commissioning_date'
  | 'medical_certificate_issue_date';

export interface ParameterDefinition<T = unknown> {
  key: string;
  axis: DateAxis;
  /** `attest_allowed` lets an owner attestation extend an open-ended version past its review
   * horizon for issuing documents; filing still requires a signed version. */
  continuity: 'block' | 'attest_allowed';
  /** Names of the scope dimensions, e.g. `category` for VAT rates. */
  scope: readonly string[];
  value: ZodType<T>;
  description: string;
}

export interface ParameterVersion {
  id: string;
  key: string;
  scope: Record<string, string>;
  value: JsonValue;
  from: LocalDate;
  to: LocalDate | null;
  /** Required when `to` is null: the last date a reviewer confirmed the value still applies. */
  reviewedThrough: LocalDate | null;
  /** Publication date of the governing text, distinct from the effective date; null until the
   * text has been located and snapshotted. */
  knowledgeDate: LocalDate | null;
  status: ReviewStatus;
  /** Clause references, e.g. `L227/2015 art. 291 alin. (1) lit. a)`. */
  clauses: readonly string[];
  withdrawn?: boolean;
}

export interface Attestation {
  id: string;
  key: string;
  scope: Record<string, string>;
  from: LocalDate;
  to: LocalDate;
}

export type GapReason = 'NO_VERSION' | 'BEYOND_HORIZON' | 'INSUFFICIENT_REVIEW' | 'AMBIGUOUS';
export interface RuleGap {
  key: string;
  axis: DateAxis;
  date: LocalDate;
  scope: Record<string, string>;
  reason: GapReason;
  have?: ReviewStatus;
  need?: ReviewStatus;
}

export type Resolution<T> =
  | { ok: true; value: T; versionId: string; status: ReviewStatus; attestationId?: string }
  | { ok: false; gap: RuleGap };

export class RuleGapError extends Error {
  constructor(readonly gap: RuleGap) {
    super(`Parametru legal indisponibil: ${gap.key} la ${gap.date} (${gap.reason}).`);
  }
}

const sameScope = (a: Record<string, string>, b: Record<string, string>) =>
  canonical(a) === canonical(b);

export interface ResolveQuery {
  axis: DateAxis;
  date: LocalDate;
  scope?: Record<string, string>;
  mode: UseMode;
}

/** Resolves one parameter. It never defaults and never falls back to the latest version. */
export function resolveParameter<T>(
  definition: ParameterDefinition<T>,
  versions: readonly ParameterVersion[],
  query: ResolveQuery,
  attestations: readonly Attestation[] = [],
): Resolution<T> {
  if (query.axis !== definition.axis)
    throw new TypeError(`${definition.key} is selected by ${definition.axis}, not ${query.axis}.`);
  const scope = query.scope ?? {};
  const gap = (reason: GapReason, extra: Partial<RuleGap> = {}): Resolution<T> => ({
    ok: false,
    gap: { key: definition.key, axis: definition.axis, date: query.date, scope, reason, ...extra },
  });
  const matches = versions.filter(
    (version) =>
      version.key === definition.key &&
      !version.withdrawn &&
      sameScope(version.scope, scope) &&
      version.from <= query.date &&
      (version.to === null || query.date <= version.to),
  );
  if (matches.length === 0) return gap('NO_VERSION');
  if (matches.length > 1) return gap('AMBIGUOUS');
  const version = matches[0]!;
  const need = requiredStatus[query.mode];
  if (rank[version.status] < rank[need])
    return gap('INSUFFICIENT_REVIEW', { have: version.status, need });
  let attestationId: string | undefined;
  if (
    version.to === null &&
    version.reviewedThrough !== null &&
    query.date > version.reviewedThrough
  ) {
    const attestation =
      definition.continuity === 'attest_allowed' && query.mode !== 'filing'
        ? attestations.find(
            (item) =>
              item.key === definition.key &&
              sameScope(item.scope, scope) &&
              item.from <= query.date &&
              query.date <= item.to,
          )
        : undefined;
    if (!attestation) return gap('BEYOND_HORIZON');
    attestationId = attestation.id;
  }
  return {
    ok: true,
    value: definition.value.parse(version.value),
    versionId: version.id,
    status: version.status,
    ...(attestationId ? { attestationId } : {}),
  };
}

export interface RegisterProblem {
  versionId: string;
  problem: 'UNKNOWN_KEY' | 'SCOPE' | 'INTERVAL' | 'HORIZON' | 'VALUE' | 'OVERLAP';
}

/** A set of parameter definitions and versions, checked for consistency when built. */
export class ParameterRegister {
  private readonly definitions = new Map<string, ParameterDefinition>();

  constructor(
    definitions: readonly ParameterDefinition[],
    readonly versions: readonly ParameterVersion[],
  ) {
    for (const definition of definitions) this.definitions.set(definition.key, definition);
    const problems = this.check();
    if (problems.length) throw new Error(`Invalid parameter register: ${JSON.stringify(problems)}`);
  }

  /** Content hash of the register; bound into proposals that resolve from it. */
  get hash() {
    return hashOf(this.versions.map((version) => ({ ...version, clauses: [...version.clauses] })));
  }

  check(): RegisterProblem[] {
    const problems: RegisterProblem[] = [];
    const active = this.versions.filter((version) => !version.withdrawn);
    for (const version of this.versions) {
      const definition = this.definitions.get(version.key);
      const fail = (problem: RegisterProblem['problem']) =>
        problems.push({ versionId: version.id, problem });
      if (!definition) {
        fail('UNKNOWN_KEY');
        continue;
      }
      const keys = Object.keys(version.scope).sort();
      if (canonical(keys) !== canonical([...definition.scope].sort())) fail('SCOPE');
      if (version.to !== null && version.to < version.from) fail('INTERVAL');
      if (version.to === null && version.reviewedThrough === null) fail('HORIZON');
      if (!definition.value.safeParse(version.value).success) fail('VALUE');
      if (
        !version.withdrawn &&
        active.some(
          (other) =>
            other.id !== version.id &&
            other.key === version.key &&
            sameScope(other.scope, version.scope) &&
            other.from <= (version.to ?? '9999-12-31') &&
            version.from <= (other.to ?? '9999-12-31'),
        )
      )
        fail('OVERLAP');
    }
    return problems;
  }

  definition<T>(key: string): ParameterDefinition<T> {
    const definition = this.definitions.get(key);
    if (!definition) throw new TypeError(`Unknown parameter ${key}.`);
    return definition as ParameterDefinition<T>;
  }

  /** The keys of every defined parameter, in definition order. */
  keys(): string[] {
    return [...this.definitions.keys()];
  }

  /** The same definitions over other versions: what a register would resolve after a change. */
  withVersions(versions: readonly ParameterVersion[]) {
    return new ParameterRegister([...this.definitions.values()], versions);
  }

  resolve<T>(key: string, query: ResolveQuery, attestations: readonly Attestation[] = []) {
    return resolveParameter<T>(this.definition<T>(key), this.versions, query, attestations);
  }

  /** Open-ended versions whose review horizon ends on or before `date`. */
  horizon(date: LocalDate) {
    return this.versions.filter(
      (version) =>
        !version.withdrawn &&
        version.to === null &&
        version.reviewedThrough !== null &&
        version.reviewedThrough <= date,
    );
  }
}

/**
 * The parameter access a treatment receives. It records every version it resolves so the
 * proposal can bind them, and throws a RuleGapError the kernel turns into a blocking issue.
 */
export class RuleContext {
  readonly used = new Map<string, { status: ReviewStatus; attestationId?: string }>();

  constructor(
    private readonly register: ParameterRegister,
    readonly mode: UseMode,
    private readonly attestations: readonly Attestation[] = [],
  ) {}

  param<T>(key: string, axis: DateAxis, date: LocalDate, scope?: Record<string, string>): T {
    const result = this.register.resolve<T>(
      key,
      { axis, date, mode: this.mode, ...(scope ? { scope } : {}) },
      this.attestations,
    );
    if (!result.ok) throw new RuleGapError(result.gap);
    this.used.set(result.versionId, {
      status: result.status,
      ...(result.attestationId ? { attestationId: result.attestationId } : {}),
    });
    return result.value;
  }
}
