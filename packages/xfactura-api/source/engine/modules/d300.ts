import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { profileAt, vatPeriodOf, type ReadSetEntry } from 'xfactura-core/kernel';
import { divRound } from 'xfactura-core/money';
import {
  checkD300,
  d300Namespace,
  writeD300,
  type D300,
  type D300InputElement,
} from 'xfactura-core/ro/declarations/d300';
import { counties } from 'xfactura-core/ro/geo';
import { vatPeriodEnd } from 'xfactura-core/ro/treatments/vat-settlement';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { companies, parties, partyVersions } from '../db/schema';
import { loadState } from '../kernel/state';
import type { DeclarationKind, DeclarationProblem } from './declarations';

const vatPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/);
export const d300Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    caen: z.string().regex(/^\d{4}$/),
    bank: z.string().trim().min(1).max(50),
    account: z.string().trim().min(1).max(50),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
    /** The printed form pre-fills 100; a company with mixed operations records its own. */
    proRata: z
      .string()
      .regex(/^(100|\d{1,2})(\.\d{1,2})?$/)
      .default('100'),
    refundRequested: z.boolean().default(false),
  })
  .strict();

/**
 * Where the books' tax entries go on the return: collected VAT by rate on rows 9–10, purchases
 * by rate on rows 24–25 (the 19% rows only for 2025 periods), and the VAT deducted on row 31.
 * Purchases enter rows 24–25 with all their VAT and row 31 holds only the deductible part; that
 * reading of rows 24–25 versus 31 is an interpretation for the expert's review.
 */
const rowsByCode: Record<'output' | 'input', Record<string, string>> = {
  output: { 'S-21': 'R9', 'S-11': 'R10', 'S-19': 'R69' },
  input: { 'S-21': 'R22', 'S-11': 'R23', 'S-19': 'R74' },
};

function returnPeriod(period: string): D300['period'] {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return { year: Number(quarter[1]), month: Number(quarter[2]) * 3 };
  return { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) };
}

function periodStart(period: string): LocalDate {
  const { year, month } = returnPeriod(period);
  const first = period.includes('Q') ? month - 2 : month;
  return `${year}-${String(first).padStart(2, '0')}-01` as LocalDate;
}

/** How bani round to the whole lei the return is in, from the rule register. */
async function rounding(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  tx: Transaction,
  companyId: string,
  date: LocalDate,
  problems: DeclarationProblem[],
) {
  try {
    const rule = (await rules(tx, companyId)).param<string>(
      'ro.declaration.rounding',
      'reporting_period_start',
      date,
    );
    if (rule !== 'half_up_leu') throw new Error(`Unknown rounding ${rule}.`);
    return (bani: bigint) => divRound(bani, 100n, 'halfAwayFromZero');
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    problems.push({ code: 'RULE_GAP', message: error.message });
    return null;
  }
}

async function sellerDetails(tx: Transaction, companyId: string) {
  const [row] = await tx
    .select({
      partyId: partyVersions.partyId,
      version: partyVersions.version,
      details: partyVersions.details,
      hash: partyVersions.detailsHash,
    })
    .from(partyVersions)
    .innerJoin(
      parties,
      and(eq(parties.companyId, partyVersions.companyId), eq(parties.id, partyVersions.partyId)),
    )
    .where(and(eq(partyVersions.companyId, companyId), eq(parties.kind, 'self')))
    .orderBy(desc(partyVersions.version))
    .limit(1);
  return row;
}

async function inputsOf(tx: Transaction, companyId: string, period: string) {
  const { loaded, readSet } = await loadState(tx, companyId, {
    taxPeriods: [{ tax: 'VAT', period }],
    profile: true,
  });
  const seller = await sellerDetails(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  return { loaded, seller, inputs };
}

/** The VAT return (D300) from the VAT ledger of a tax period. */
export function d300Declaration(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  return {
    kind: 'D300',
    description: 'Decont de taxă pe valoarea adăugată (D300)',
    tax: 'VAT',
    period: vatPeriod,
    format(period) {
      try {
        return `D300 ${d300Namespace(returnPeriod(period))}`;
      } catch {
        return null;
      }
    },
    options: d300Options,
    inputs: async (tx, companyId, period) => (await inputsOf(tx, companyId, period)).inputs,
    async prepare(tx, companyId, period, raw) {
      const options = d300Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { loaded, seller, inputs } = await inputsOf(tx, companyId, period);
      const end = vatPeriodEnd(period);
      if (vatPeriodOf(loaded, end) !== period)
        problems.push({
          code: 'VAT_PERIOD',
          message: `Perioada fiscală a companiei pentru ${end} este ${vatPeriodOf(loaded, end)}, nu ${period}.`,
        });
      if (profileAt(loaded, 'vat.status', end) !== 'normal_vat')
        problems.push({
          code: 'NOT_VAT_PAYER',
          message: 'Decontul D300 îl depun plătitorii de TVA.',
        });
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });

      const roundToLeu = await rounding(rules, tx, companyId, periodStart(period), problems);
      const totals = new Map<string, bigint>();
      const add = (element: string, bani: bigint) =>
        totals.set(element, (totals.get(element) ?? 0n) + bani);
      let deducted = 0n;
      for (const entry of loaded.taxLedger.get(`VAT|${period}`)?.entries ?? []) {
        const row = rowsByCode[entry.direction][entry.code];
        if (!row) {
          problems.push({
            code: 'D300_CODE',
            message: `Operațiunile ${entry.direction === 'output' ? 'colectate' : 'deductibile'} cu codul ${entry.code} nu au încă un rând în decont.`,
          });
          continue;
        }
        add(`${row}_1`, entry.baseBani);
        add(`${row}_2`, entry.taxBani);
        if (entry.direction === 'input') deducted += entry.deductibleBani;
      }
      if (deducted !== 0n) add('R28_2', deducted);
      if (problems.length || !seller || !roundToLeu)
        return { xml: '', inputs, problems, summary: null };

      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D300 = {
        period: returnPeriod(period),
        type: period.includes('Q') ? 'T' : 'L',
        company: {
          cui: company!.cui,
          name: details.name,
          address: [
            ...address.lines,
            address.city,
            address.subdivision
              ? (counties[address.subdivision] ?? address.subdivision)
              : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          ...(options.phone ? { phone: options.phone } : {}),
          ...(options.email ? { email: options.email } : {}),
          bank: options.bank,
          account: options.account,
          caen: options.caen,
        },
        declarant: options.declarant,
        groupRepresentative: false,
        simplifiedDomestic: false,
        afterReserveCancellation: false,
        proRata: options.proRata,
        reverseCharge: {
          cereals: false,
          mobilePhones: false,
          integratedCircuits: false,
          consoles: false,
        },
        refundRequested: options.refundRequested,
        rows: Object.fromEntries(
          [...totals].map(([element, bani]) => [element, Number(roundToLeu(bani))]),
        ) as Partial<Record<D300InputElement, number>>,
      };
      for (const check of checkD300(model))
        if (check.severity === 'error') problems.push({ code: check.code, message: check.message });
      return {
        xml: problems.length ? '' : writeD300(model),
        inputs,
        problems,
        summary: { period, type: model.type, rows: model.rows },
      };
    },
  };
}
