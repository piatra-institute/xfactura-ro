import { z } from 'zod';
import type { Effect, FxRate, Issue, LineSpec, Treatment } from '../../kernel';
import {
  convertMinor,
  formatMoney,
  isSupportedCurrency,
  LEDGER_CURRENCY,
  parseMoney,
} from '../../money';
import { isLocalDate, type LocalDate } from '../../time';
import {
  financingClauses,
  INDEXED_LEASE_METHOD,
  interestRows,
  LEASE_INTEREST_ACCOUNT,
  LEASE_METHOD,
  loanSchedule,
  principalRows,
} from '../financing';
import { selectRate } from '../fx';
import { planInput, planInstalments } from './loans';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const localDate = z
  .string()
  .refine((value): boolean => isLocalDate(value))
  .transform((value) => value as LocalDate);

/** The tangible fixed assets a finance lease brings in on 167 (OMFP 1802/2014, the function of
 * account 167): buildings and installations (212), machinery, equipment and vehicles (213),
 * furniture and office equipment (214), and the other tangible assets kept on 216. */
const leasedAsset = /^21[2346]/;

export const commencementInput = z
  .object({
    /** The day the lessor makes the asset available: the financing is granted then. */
    date: localDate,
    lessorId: z.uuid(),
    /** The leasing contract with its schedule, and the delivery record. */
    evidenceId: z.uuid(),
    /** The asset, registered with the value this entry books (`assets.register`). */
    assetId: z.uuid(),
    /** The contract's currency. */
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** The asset's value as the contract states it, in its currency: what the lessor financed,
     * the advance and the residual value included. */
    value: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
    /** For a contract in a currency: whether its instalments are invoiced and paid in lei at
     * the currency's rate (a liability in lei settled by a currency's rate) or in the currency. */
    settlement: z.enum(['currency', 'lei']).optional(),
    ...planInput,
  })
  .strict()
  .refine((input) => (input.instalments === undefined) !== (input.terms === undefined), {
    message: 'Indicați fie ratele din graficul de leasing, fie condițiile contractului.',
  })
  .refine(
    (input) => (input.currency === LEDGER_CURRENCY) === (input.settlement === undefined),
    'Pentru un contract în valută indicați decontarea: în valută (currency) sau în lei la cursul valutei (lei).',
  );
export type CommencementInput = z.infer<typeof commencementInput>;

/**
 * A finance lease, for the lessee (OMFP 1802/2014 pct. 212–215, the functions of accounts 167,
 * 404 and 666; Codul fiscal art. 29 alin. (1)–(2): the lessee is treated as the owner and
 * depreciates): the asset enters the books at the value the contract states, against the lease
 * liability (Dr 21x / Cr 167), an open item of the lessor in the contract's currency, recorded
 * at the accounting rate of the day the financing is granted (pct. 321). Its schedule holds the
 * contract's principal on 167 and each period's interest, booked from the lessor's invoice on 666
 * (`invoices.recognize` with the lease named on its 167 part). The asset is the one registered,
 * so its depreciation runs from the register (`assets.depreciate`).
 */
export const leaseCommencement: Treatment<CommencementInput> = {
  id: 'leases.commence',
  version: 1,
  description:
    'Leasing financiar la utilizator: imobilizarea primită (21x) și datoria față de finanțator (167), cu graficul de rate.',
  input: commencementInput,
  agent: true,
  summary:
    'Start of a finance lease for the lessee: the asset received (21x) and the debt to the lessor (167), with the instalment schedule.',
  subject: (input) => `lease:${input.assetId}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    parties: [input.lessorId],
    assets: true,
    ...(input.currency !== LEDGER_CURRENCY
      ? { fx: [{ currency: input.currency, until: input.date }], profile: true }
      : {}),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const lessor = loaded.parties.get(input.lessorId);
    if (!lessor) issues.push(block('PARTY', 'Finanțatorul nu există.', 'lessorId'));
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Contractul de leasing nu este disponibil.', 'evidenceId'));
    if (!isSupportedCurrency(input.currency))
      return {
        effect: null,
        issues: [block('CURRENCY', `Moneda ${input.currency} nu este acceptată.`, 'currency')],
      };
    const asset = loaded.assets.get(input.assetId);
    if (!asset)
      return { effect: null, issues: [block('ASSET', 'Mijlocul fix nu există.', 'assetId')] };
    if (!leasedAsset.test(asset.account))
      issues.push(
        block(
          'ASSET_ACCOUNT',
          `Contul ${asset.account} nu este al unei imobilizări corporale primite în leasing financiar (212, 213, 214, 216).`,
          'assetId',
        ),
      );
    if (asset.commissionedOn < input.date)
      issues.push(
        block(
          'ASSET_DATE',
          'Mijlocul fix nu poate fi pus în funcțiune înaintea începerii leasingului.',
          'assetId',
        ),
      );
    if (asset.depreciated !== 0n || asset.disposedOn)
      issues.push(block('ASSET_USED', 'Mijlocul fix are deja amortizare sau ieșire înregistrată.'));
    const currency = input.currency;
    let rate: FxRate | undefined;
    if (currency !== LEDGER_CURRENCY) {
      const selected = selectRate(loaded, rules, currency, input.date, 'accounting');
      if ('code' in selected) issues.push(selected);
      else rate = selected;
    }
    if (issues.length) return { effect: null, issues };

    const value = parseMoney(input.value, currency);
    const bani = rate
      ? convertMinor(value, currency, { rate: rate.rate, multiplier: rate.multiplier })
      : value;
    if (asset.value !== bani)
      issues.push(
        block(
          'ASSET_VALUE',
          `Mijlocul fix ${asset.number} este înregistrat cu ${formatMoney(asset.value, LEDGER_CURRENCY)} lei; leasingul îl aduce la ${formatMoney(bani, LEDGER_CURRENCY)} lei${rate ? ` (${input.value} ${currency} la cursul ${rate.rate})` : ''}.`,
          'assetId',
        ),
      );
    const { instalments } = planInstalments(input, value, currency);
    const plan = loanSchedule(instalments, input.date, '167', LEASE_INTEREST_ACCOUNT);
    issues.push(...plan.issues);
    const principal = principalRows(plan.rows, '167').reduce((sum, row) => sum + row.bani, 0n);
    if (principal !== value)
      issues.push(
        block(
          'SCHEDULE_PRINCIPAL',
          `Ratele de capital însumează ${formatMoney(principal, currency)} ${currency}, iar valoarea finanțată este ${input.value} ${currency}.`,
          'instalments',
        ),
      );
    if (issues.length) return { effect: null, issues };

    const indexed = input.settlement === 'lei';
    const liability: LineSpec = {
      account: '167',
      side: 'C',
      bani,
      openItem: 'lease',
      partyId: input.lessorId,
      ...(rate
        ? { currency: { code: currency, minor: value, rateId: rate.id, rate: rate.rate } }
        : {}),
    };
    const lastDue = plan.rows.at(-1)!.due;
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'IMOBILIZARI',
      description: `Leasing financiar ${asset.number} ${asset.name}`.slice(0, 500),
      lines: [
        {
          account: asset.account,
          side: 'D',
          bani,
          analytics: { item: asset.id },
          memo: `${asset.number} ${asset.name}`.slice(0, 500),
        },
        liability,
      ],
      openItems: [
        {
          ref: 'lease',
          kind: 'loan.payable',
          controlAccount: '167',
          partyId: input.lessorId,
          currency,
          normalSide: 'C',
          mayReverse: false,
          dueDate: lastDue,
        },
      ],
      taxEntries: [],
      schedules: [
        {
          ref: 'plan',
          openItem: 'lease',
          version: 1,
          // A contract settled in lei at a currency's rate keeps its differences on 668 and 768.
          method: indexed ? INDEXED_LEASE_METHOD : LEASE_METHOD,
          rows: plan.rows,
          basis: {
            start: input.date,
            evidenceId: input.evidenceId,
            assetId: asset.id,
            settlement: input.settlement ?? 'lei',
            ...(input.terms ? { terms: input.terms } : {}),
          },
        },
      ],
      explanation: {
        summary: `${asset.number} ${asset.name}: ${input.value} ${currency}${rate ? ` la cursul ${rate.rate} (${rate.date})` : ''}, ${formatMoney(bani, LEDGER_CURRENCY)} lei pe ${asset.account} și 167, în ${principalRows(plan.rows, '167').length} rate până la ${lastDue}.`,
        details: {
          asset: asset.number,
          interest: formatMoney(
            interestRows(plan.rows).reduce((sum, row) => sum + row.bani, 0n),
            currency,
          ),
          ...(input.settlement ? { settlement: input.settlement } : {}),
          clauses: [financingClauses.lease, ...(rate ? [financingClauses.leaseCurrency] : [])],
        },
      },
    };
    return { effect, issues };
  },
};
