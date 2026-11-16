import type { Party } from 'xfactura-core/einvoice';
import type { D406Filed, D406FiledAddress, D406FiledParty } from 'xfactura-core/ro/saft/read';
import type { PartyCreation } from '../mapping/schema';
import { order } from '../compare/differences';
import { monthEnd, rootAttribute, type FiledReturn } from './filed-returns';

/** The profile axes the return replay reads from filed files. */
export const factAxes = ['vat.status', 'vat.cash', 'vat.period', 'activity.none'] as const;
export type FactAxis = (typeof factAxes)[number];

/** The filed file a fact rests on: its form, its period and its payload's hash. */
export type FactEvidence = {
  form: 'D406' | 'D300' | 'D394' | 'S1005';
  period: string;
  sha256: string;
};

/** What one filed file states about an axis over its own months. */
export type FactStatement = {
  axis: FactAxis;
  value: string;
  /** First and last day the file covers. */
  from: string;
  to: string;
  /** Which part of the file states it. */
  reason: string;
  evidence: FactEvidence;
};

/** A dated profile fact the lab records, with the file that states it. */
export type DerivedFact = {
  axis: FactAxis;
  value: string;
  effectiveFrom: string;
  reason: string;
  evidence: FactEvidence;
};

/** Files that state different values for overlapping days: the owner's question. */
export type FactConflict = { axis: FactAxis; from: string; to: string; reason: 'FACT_CONFLICT' };

/**
 * Nomenclator_Regim_fiscal, the D406 header's TaxRegistration TaxType, read back into the profile
 * axes the engine's D406 writes it from (d406.ts): 100010 registered, 100040 registered under VAT
 * on collection, 100020 the small enterprises' special exemption scheme, which the engine writes
 * for a company outside VAT. The other codes have no engine reading and state nothing here.
 */
const regimes: Readonly<Record<string, { status: string; cash?: string }>> = {
  '100010': { status: 'normal_vat', cash: 'no' },
  '100040': { status: 'normal_vat', cash: 'yes' },
  '100020': { status: 'non_vat' },
};

/** The VAT period a return's type states: L monthly, T quarterly. */
const vatPeriods: Readonly<Record<string, string>> = { L: 'monthly', T: 'quarterly' };

/**
 * What each filed file states about the company's profile:
 * - a D406 header's tax registration states the VAT status (and VAT on collection), and for a
 *   company registered for VAT its file type (L, T) states the VAT period, which the file follows
 *   (OPANAF nr. 1.783/2021 anexa nr. 4 pct. 3, as the engine's D406 cites it);
 * - a D300 or D394 states the company was registered for VAT in its months (only those
 *   registered file them, as the engine's own checks say), its type the VAT period, and D394's
 *   sistemTVA whether it applied VAT on collection;
 * - a filed S1005 rather than the inactivity declaration states activity in its year (Legea
 *   82/1991 art. 36 alin. (2), as the engine's S1005 cites it).
 */
export function factStatements(
  d406: readonly {
    period: string;
    start: string;
    end: string;
    filing: { filed: D406Filed; sha256: string };
  }[],
  returns: readonly FiledReturn[],
): FactStatement[] {
  const statements: FactStatement[] = [];
  for (const { period, start, end, filing } of d406) {
    const evidence: FactEvidence = { form: 'D406', period, sha256: filing.sha256 };
    const registration = filing.filed.header.company.taxRegistrations.find(
      (item) => item.taxType !== undefined && regimes[item.taxType],
    );
    const regime = registration ? regimes[registration.taxType!]! : undefined;
    if (!regime) continue;
    const at = { from: start, to: end, evidence };
    statements.push({
      axis: 'vat.status',
      value: regime.status,
      reason: 'D406_TAX_REGISTRATION',
      ...at,
    });
    if (regime.cash)
      statements.push({
        axis: 'vat.cash',
        value: regime.cash,
        reason: 'D406_TAX_REGISTRATION',
        ...at,
      });
    const vatPeriod = vatPeriods[filing.filed.header.type ?? ''];
    if (regime.status === 'normal_vat' && vatPeriod)
      statements.push({ axis: 'vat.period', value: vatPeriod, reason: 'D406_FILE_TYPE', ...at });
  }
  for (const item of returns) {
    const evidence: FactEvidence = {
      form: item.form,
      period: item.period ?? `${item.months.to}/${item.type}`,
      sha256: item.sha256,
    };
    const at = { from: `${item.months.from}-01`, to: monthEnd(item.months.to), evidence };
    if (item.form === 'S1005') {
      statements.push({ axis: 'activity.none', value: 'no', reason: 'S1005_FILED', ...at });
      continue;
    }
    statements.push({
      axis: 'vat.status',
      value: 'normal_vat',
      reason: `${item.form}_FILED`,
      ...at,
    });
    const vatPeriod = vatPeriods[item.type];
    if (vatPeriod)
      statements.push({ axis: 'vat.period', value: vatPeriod, reason: `${item.form}_TYPE`, ...at });
    if (item.form === 'D394') {
      const system = rootAttribute(item.declaration, 'sistemTVA');
      if (system === '1' || system === '0')
        statements.push({
          axis: 'vat.cash',
          value: system === '1' ? 'yes' : 'no',
          reason: 'D394_CASH_SYSTEM',
          ...at,
        });
    }
  }
  return statements;
}

const formOrder = ['D300', 'D394', 'D406', 'S1005'];

/**
 * The dated facts the statements give: on each axis a fact from the first day a file states a
 * value and again where the value changes, each citing the first file stating it. An axis whose
 * files state different values for overlapping days is the owner's question and gets no fact.
 */
export function deriveFacts(statements: readonly FactStatement[]): {
  facts: DerivedFact[];
  conflicts: FactConflict[];
} {
  const facts: DerivedFact[] = [];
  const conflicts: FactConflict[] = [];
  for (const axis of factAxes) {
    const own = statements
      .filter((item) => item.axis === axis)
      .sort(
        (a, b) =>
          order(a.from, b.from) ||
          formOrder.indexOf(a.evidence.form) - formOrder.indexOf(b.evidence.form),
      );
    const clashes = own.flatMap((a, i) =>
      own
        .slice(i + 1)
        .filter((b) => b.value !== a.value && b.from <= a.to && a.from <= b.to)
        .map((b) => ({ from: a.from < b.from ? b.from : a.from, to: a.to < b.to ? a.to : b.to })),
    );
    if (clashes.length) {
      conflicts.push({
        axis,
        from: clashes.map((item) => item.from).sort(order)[0]!,
        to: clashes
          .map((item) => item.to)
          .sort(order)
          .at(-1)!,
        reason: 'FACT_CONFLICT',
      });
      continue;
    }
    let current: string | undefined;
    for (const item of own) {
      if (item.value === current) continue;
      current = item.value;
      facts.push({
        axis,
        value: item.value,
        effectiveFrom: item.from,
        reason: item.reason,
        evidence: item.evidence,
      });
    }
  }
  return { facts, conflicts };
}

/** The value a list of dated facts gives an axis on a day, or undefined before any. */
export function factAt(facts: readonly DerivedFact[], axis: FactAxis, date: string) {
  let value: string | undefined;
  for (const fact of facts)
    if (fact.axis === axis && fact.effectiveFrom <= date) value = fact.value;
  return value;
}

/** An address as the engine keeps it, when the file states a street, a locality and a country. */
function addressOf(address: D406FiledAddress | undefined): Party['address'] | undefined {
  const street = [address?.street, address?.number].filter((part) => part?.trim()).join(' ');
  if (!address || !street || !address.city?.trim() || !/^[A-Z]{2}$/.test(address.country ?? ''))
    return undefined;
  return {
    lines: [
      street.slice(0, 150),
      ...(address.details?.trim() ? [address.details.trim().slice(0, 150)] : []),
    ],
    city: address.city.trim().slice(0, 100),
    ...(address.postalCode?.trim() ? { postalCode: address.postalCode.trim().slice(0, 20) } : {}),
    ...(address.county?.trim() ? { subdivision: address.county.trim().slice(0, 100) } : {}),
    country: address.country!,
  };
}

/**
 * The company's identification as the first replayed D406 header states it: its name, CUI and
 * registered office. Undefined when the header lacks the name, a street, the locality or the
 * country.
 */
export function sellerOf(filed: D406Filed, cui: string): Party | undefined {
  const { name } = filed.header.company;
  const address = addressOf(filed.header.company.address);
  if (!name?.trim() || !address) return undefined;
  return { name: name.trim().slice(0, 200), legalId: cui, address };
}

/**
 * A partner's invoicing details as a D406 master file states them: its name and address, under
 * the identifier the mapping created it with. Undefined without a stated address.
 */
export function partnerOf(record: D406FiledParty, party: PartyCreation): Party | undefined {
  const address = addressOf(record.address);
  const name = (record.name ?? party.name).trim();
  if (!address || !name || address.country !== party.country) return undefined;
  return { name: name.slice(0, 200), ...(party.taxId ? { legalId: party.taxId } : {}), address };
}
