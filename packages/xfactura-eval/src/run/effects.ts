import type { ProposalView } from '../../../xfactura-api/source/engine/kernel/views';

/*
 * Effects compared across engines. Identifiers differ from one engine to the next, so an effect
 * is reduced to what an accountant compares: accounts, sides and amounts; tax entries by code,
 * base, tax and deduction; periods; partners by tax id; release schedules.
 */

export type Normal = {
  treatment: string;
  status: string;
  /** The entry's date and month; null without an effect. */
  date: string | null;
  month: string | null;
  lines: string[];
  taxes: string[];
  taxPeriods: string[];
  /** The accounts a decision chooses: lines without a partner, off the VAT and treasury
   * accounts, with their side. */
  accounts: string[];
  partners: string[];
  schedules: string[];
  /** VAT and deduction, as one label per tax entry (`in S-21 full`, `out RC-EU-SERV`). */
  vat: string[];
  /** In bani: output VAT, deductible input VAT, and the result (revenue less expenses). */
  output: bigint;
  deductible: bigint;
  profit: bigint;
};

/** Bani of a decimal amount in lei. */
export function bani(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = amount.replace(/^-/, '').split('.');
  const value = BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -value : value;
}
/** Lei of an amount in bani. */
export function lei(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

const vatAccount = /^44[23]/;
const treasuryAccount = /^5[1-4]/;

export async function normalize(
  view: ProposalView,
  partyKey: (id: string) => Promise<string>,
): Promise<Normal> {
  const effect = view.effect;
  const parties = new Map<string, string>();
  const key = async (id: string | undefined) => {
    if (!id) return '';
    if (!parties.has(id)) parties.set(id, await partyKey(id));
    return parties.get(id)!;
  };
  const lines: string[] = [];
  const accounts = new Set<string>();
  const partners = new Set<string>();
  let profit = 0n;
  for (const line of effect?.lines ?? []) {
    const party = await key(line.partyId);
    lines.push(`${line.side} ${line.account} ${line.amount}${party ? ` @${party}` : ''}`);
    if (party) partners.add(party);
    else if (!vatAccount.test(line.account) && !treasuryAccount.test(line.account))
      accounts.add(`${line.side} ${line.account}`);
    const amount = bani(line.amount);
    if (line.account.startsWith('7')) profit += line.side === 'C' ? amount : -amount;
    if (line.account.startsWith('6')) profit += line.side === 'D' ? -amount : amount;
  }
  for (const item of effect?.openItems ?? []) partners.add(await key(item.partyId));
  let output = 0n;
  let deductible = 0n;
  const taxes: string[] = [];
  const taxPeriods: string[] = [];
  const vat: string[] = [];
  for (const entry of effect?.taxEntries ?? []) {
    taxes.push(
      `${entry.direction} ${entry.code} base ${entry.base} tax ${entry.amount} deductible ${entry.deductible}`,
    );
    taxPeriods.push(`${entry.code} ${entry.taxPeriod ?? 'not chargeable'}`);
    if (entry.direction === 'output') {
      output += bani(entry.amount);
      vat.push(`out ${entry.code}`);
    } else {
      deductible += bani(entry.deductible);
      const share =
        entry.deductible === entry.amount
          ? 'full'
          : bani(entry.deductible) === 0n
            ? 'none'
            : 'partial';
      vat.push(`in ${entry.code} ${share}`);
    }
  }
  const schedules = (effect?.schedules ?? []).flatMap((schedule) =>
    schedule.rows.map((row) => `${row.due} ${row.amount} ${row.counterAccount}`),
  );
  return {
    treatment: view.treatment,
    status: view.status,
    date: effect?.date ?? null,
    month: effect?.date.slice(0, 7) ?? null,
    lines: lines.sort(),
    taxes: taxes.sort(),
    taxPeriods: taxPeriods.sort(),
    accounts: [...accounts].sort(),
    partners: [...partners].filter(Boolean).sort(),
    schedules: schedules.sort(),
    vat: vat.sort(),
    output,
    deductible,
    profit,
  };
}

export type Field = 'treatment' | 'account' | 'vat' | 'period' | 'partner';
export const fields: Field[] = ['treatment', 'account', 'vat', 'period', 'partner'];
export type FieldOutcome = 'match' | 'mismatch' | 'missing';

export type Comparison = {
  exact: boolean;
  fields: Record<Field, FieldOutcome>;
  /** Critical errors: VAT charged or deducted wrongly, VAT in another return's period, the
   * wrong partner. */
  critical: ('vat' | 'period' | 'partner')[];
  /** Agent less gold, in bani: the VAT position (output less deductible) and the result. */
  vatDelta: bigint;
  profitDelta: bigint;
};

const same = (a: string[], b: string[]) => a.join('\n') === b.join('\n');
const label = (items: string[]) => (items.length ? items.join(' + ') : '(none)');

/** The value of a field, as the confusion tables show it. */
export function fieldValue(normal: Normal, field: Field): string {
  switch (field) {
    case 'treatment':
      return normal.treatment;
    case 'account':
      return label(normal.accounts);
    case 'vat':
      return label(normal.vat);
    case 'period':
      return `${normal.month ?? '(none)'} | ${label(normal.taxPeriods)}`;
    case 'partner':
      return label(normal.partners);
  }
}

/** An agent's booking (null: none, or one with no effect) against the gold one. */
export function compare(gold: Normal, agent: Normal | null): Comparison {
  const position = (normal: Normal) => normal.output - normal.deductible;
  if (!agent || agent.date === null)
    return {
      exact: false,
      fields: {
        treatment: agent && agent.treatment === gold.treatment ? 'match' : 'missing',
        account: 'missing',
        vat: 'missing',
        period: 'missing',
        partner: 'missing',
      },
      critical: [],
      vatDelta: -position(gold),
      profitDelta: -gold.profit,
    };
  const outcome = (equal: boolean): FieldOutcome => (equal ? 'match' : 'mismatch');
  const vatSame = same(gold.taxes, agent.taxes);
  const periodSame = gold.month === agent.month && same(gold.taxPeriods, agent.taxPeriods);
  const partnerSame = same(gold.partners, agent.partners);
  const critical: Comparison['critical'] = [];
  if (!vatSame && (gold.output !== agent.output || gold.deductible !== agent.deductible))
    critical.push('vat');
  if (!same(gold.taxPeriods, agent.taxPeriods) && gold.taxes.length + agent.taxes.length > 0)
    critical.push('period');
  if (!partnerSame) critical.push('partner');
  return {
    exact:
      gold.treatment === agent.treatment &&
      gold.date === agent.date &&
      same(gold.lines, agent.lines) &&
      vatSame &&
      same(gold.taxPeriods, agent.taxPeriods) &&
      same(gold.schedules, agent.schedules),
    fields: {
      treatment: outcome(gold.treatment === agent.treatment),
      account: outcome(same(gold.accounts, agent.accounts)),
      vat: outcome(vatSame),
      period: outcome(periodSame),
      partner: outcome(partnerSame),
    },
    critical,
    vatDelta: position(agent) - position(gold),
    profitDelta: agent.profit - gold.profit,
  };
}
