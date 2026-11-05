import { z } from 'zod';
import type { AccountTurnover, AssetState, Issue, JsonValue } from '../../kernel';
import { divRound, formatMoney, parseMoney, parseScaled } from '../../money';
import {
  normalizePlate,
  profitClassificationClauses,
  questionIssue,
  type ProfitAccountAnswer,
} from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import { d101Rows, deriveD101Rows, type D101Row, type D101Rows } from '../declarations/d101';
import {
  expenseClassifications,
  isFinancial,
  natureOf,
  revenueClassifications,
  type AccountClassification,
} from './accounts';
import {
  assetDeduction,
  basisIssues,
  depreciationRulesOf,
  isFiscalBasis,
  type AssetDeduction,
} from './depreciation';
import { recoverLosses, type LossVintage, type Recovery } from './losses';
import type {
  LegalReserveLimits,
  ReceivableImpairment,
  SponsorshipLimits,
  SuperAccelerated,
} from './parameters';

/*
 * The tax bridge (Codul fiscal art. 19): from the accounting result of a period to the fiscal
 * result and the profit tax, row by row as the annual return (D101) declares them. Revenues and
 * expenses are the books' (classes 6 and 7, cumulated from the period's start); what the law
 * makes non-taxable or non-deductible follows each account's nature (`accounts.ts`) or the
 * classification a person gave it (`profit.account`); the amounts no account holds alone are
 * stated with their evidence (`determinations`). Every row is in whole lei, rounded once from
 * bani (`ro.declaration.rounding`); the rows the return derives are derived from those, so the
 * tax booked is the tax declared.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const lei = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const accountPattern = /^[67]\d{1,3}(\.[A-Z0-9_-]{1,24})*$/;

/** Amounts no single account's nature decides: stated, with the document behind them. */
export const determinationRules = [
  /** A provision or impairment art. 26 allows (lit. b) guarantees, j) insolvent debtors, n)
   * insured or destroyed assets): not added back. */
  'provision_deductible',
  /** Impairment of receivables unpaid more than 270 days after their due date, not guaranteed,
   * from non-affiliated persons (art. 26 alin. (1) lit. c)): the stated base, of which the
   * register's share is deductible. */
  'receivables',
  /** Revenue art. 23 does not tax (lit. d): a provision reversed that was not deducted, an
   * expense recovered that was not deducted…): rd. 20. */
  'nontaxable',
  /** Expenses of non-taxable revenue (art. 25 alin. (4) lit. e)), allocated by a rational method
   * or by the share of that revenue: rd. 32. */
  'related_expenses',
  /** Another non-deductible part of an account (art. 25 alin. (4), the letter given): rd. 33. */
  'nondeductible',
] as const;

export const determinationInput = z
  .object({
    account: z.string().regex(accountPattern),
    rule: z.enum(determinationRules),
    /** For `receivables`, the impairment that qualifies; otherwise the amount itself. */
    amount: lei,
    /** The letter of the law: art. 26 for provisions, art. 23 or art. 25 alin. (4) otherwise. */
    clause: z.enum([
      'art.26(1)(b)',
      'art.26(1)(c)',
      'art.26(1)(j)',
      'art.26(1)(n)',
      'art.25(4)(e)',
      ...profitClassificationClauses,
    ]),
    evidenceId: z.uuid(),
  })
  .strict();
export type BridgeDetermination = z.infer<typeof determinationInput>;

/** A line of the bridge: what it adds or deducts, on which row, from which accounts and why. */
export interface BridgeLine {
  row: D101Row;
  /** In bani, positive: what the row receives. */
  bani: bigint;
  accounts: string[];
  clause: string;
  text: string;
  /** The answers or determinations it rests on. */
  basis: string[];
}

export interface BridgePeriod {
  /** `2026-Q3` or `2026`. */
  label: string;
  year: number;
  /** The first day the profit tax covers: 1 January, or the first day of the quarter the company
   * left the micro-enterprise regime in (art. 52 alin. (6)). */
  start: LocalDate;
  end: LocalDate;
  /** The quarter the company left the micro-enterprise regime in this year, if it did. */
  microExitQuarter: 1 | 2 | 3 | 4 | null;
}

export interface BridgeBooks {
  /** Turnover of classes 6 and 7 from `start` to `end`. */
  rows: readonly AccountTurnover[];
  /** The subscribed and paid-in capital (1012) at the period's end. */
  capital: bigint;
  /** The legal reserve (1061) at the year's start. */
  reserve: bigint;
  /** For a company that left the micro-enterprise regime after the first quarter: the favourable
   * FX difference (765 − 665) from 1 January to the day before `start` (art. 53 alin. (2) lit.
   * b)), an item similar to revenue. Null otherwise. */
  microFx: bigint | null;
  /** The fixed assets, with their fiscal basis when one is recorded. */
  assets: readonly AssetState[];
  /** Loss vintages at the year's start; null when nobody stated them. */
  losses: readonly LossVintage[] | null;
  /** The classification a person gave an account, with the answer's id. */
  classification(account: string): { answer: ProfitAccountAnswer; answerId: string } | null;
  /** What a vehicle's use answer allows (`vehicleDeduction`), with the answer's id; null when
   * nobody answered. */
  vehicle(plate: string): { deduction: 'full' | 'limited'; answerId: string } | null;
}

export interface BridgeOptions {
  determinations: readonly BridgeDetermination[];
  /** Whether the company sets aside the legal reserve for the year (art. 26 alin. (1) lit. a)). */
  legalReserve: boolean;
  /** The tax already declared for the year's earlier quarters (D101 rd. 50), whole lei. */
  declared: bigint;
  /** The reading of art. 25 alin. (4) lit. i) for a quarter: the credit applied at each quarter
   * (the engine's) or only in the annual computation (`annual_only`). */
  sponsorshipAt?: 'every_quarter' | 'annual_only';
  /** Whether this computation is the year's (the annual return) or a quarter's. */
  annual: boolean;
  /** The reading of art. 31 alin. (5) for the loss years (see `recoverLosses`). */
  profitYears?: readonly number[];
  /** The reading of norme pct. 19 alin. (1) for the legal reserve in a quarter: computed and
   * deducted at each quarter (the engine's), or only in the annual computation. */
  reserveAt?: 'every_quarter' | 'annual_only';
  /** The base of the social expenses' limit: salaries (641, the engine's) or salaries with the
   * employees' benefits and profit shares (641, 642, 644). */
  socialBase?: 'salaries' | 'salaries_benefits';
}

export interface BridgeResult {
  rows: D101Rows;
  lines: BridgeLine[];
  issues: Issue[];
  recovery: Recovery | null;
  assets: AssetDeduction[];
  /** In bani: the accounting profit before the profit tax, the bases of the limits. */
  bases: {
    profitBeforeTax: bigint;
    protocol: bigint;
    protocolLimit: bigint;
    social: bigint;
    socialLimit: bigint;
    salaries: bigint;
    turnover: bigint;
    reserveLimit: bigint;
    /** What the legal reserve may still take: a fifth of the capital less the reserve at the
     * year's start. */
    reserveRoom: bigint;
    sponsorship: bigint;
    sponsorshipLimits: { turnover: bigint; tax: bigint } | null;
  };
}

const block = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(details === undefined ? {} : { details }),
});
const ron = (bani: bigint) => formatMoney(bani, 'RON');
const toLei = (bani: bigint) => divRound(bani, 100n, 'halfAwayFromZero');
const share = (bani: bigint, percent: string, mode: 'halfAwayFromZero' | 'floor') =>
  divRound(bani * parseScaled(percent, 4), 1_000_000n, mode);
const positive = (value: bigint) => (value > 0n ? value : 0n);

/** An account's net amount: debit for an expense, credit for a revenue. */
const amountOf = (row: AccountTurnover) =>
  row.account.startsWith('6') ? row.debit - row.credit : row.credit - row.debit;

/** The classification of an account, its own or its synthetic's. */
function classified(books: BridgeBooks, account: string) {
  return books.classification(account) ?? books.classification(account.split('.')[0]!);
}

/**
 * The fiscal result and the profit tax of a period, cumulated from its start, as the rows of the
 * annual return. Issues block when a fact is missing (a question names it), when an amount
 * stated exceeds what the books hold, or when the case is not covered.
 */
export function computeBridge(
  period: BridgePeriod,
  books: BridgeBooks,
  options: BridgeOptions,
  rules: RuleContext,
): BridgeResult {
  const issues: Issue[] = [];
  const lines: BridgeLine[] = [];
  const yearStart = `${period.year}-01-01` as LocalDate;
  const add = (line: BridgeLine) => {
    if (line.bani !== 0n) lines.push(line);
  };
  const rate = rules.param<string>('ro.profit.rate', 'reporting_period_start', period.start);
  const protocolRate = rules.param<string>(
    'ro.profit.protocol_limit',
    'reporting_period_start',
    period.start,
  );
  const socialRate = rules.param<string>(
    'ro.profit.social_limit',
    'reporting_period_start',
    period.start,
  );
  const vehicleRate = rules.param<string>(
    'ro.profit.vehicle_share',
    'reporting_period_start',
    period.start,
  );
  const sponsorship = rules.param<SponsorshipLimits>(
    'ro.profit.sponsorship',
    'reporting_period_start',
    period.start,
  );
  const reserveRule = rules.param<LegalReserveLimits>(
    'ro.profit.legal_reserve',
    'reporting_period_start',
    period.start,
  );
  const rounding = rules.param<string>(
    'ro.declaration.rounding',
    'reporting_period_start',
    period.start,
  );
  if (rounding !== 'half_up_leu') throw new Error(`Unknown rounding ${rounding}.`);

  // Revenues and expenses as the books hold them: operating (rd. 1, 2, the profit tax in rd. 2)
  // and financial (rd. 4, 5).
  const rows = books.rows.filter((row) => row.debit !== row.credit);
  const sum = (filter: (row: AccountTurnover) => boolean) =>
    rows.filter(filter).reduce((total, row) => total + amountOf(row), 0n);
  const revenue = (row: AccountTurnover) => row.account.startsWith('7');
  const operatingRevenue = sum((row) => revenue(row) && !isFinancial(row.account));
  const financialRevenue = sum((row) => revenue(row) && isFinancial(row.account));
  const operatingExpense = sum((row) => !revenue(row) && !isFinancial(row.account));
  const financialExpense = sum((row) => !revenue(row) && isFinancial(row.account));
  const tax691 = sum((row) => row.account.startsWith('691'));
  const profitBeforeTax =
    operatingRevenue + financialRevenue - operatingExpense - financialExpense + tax691;
  const turnover = sum((row) => row.account.startsWith('70') || row.account.startsWith('7411'));

  // Each account by its nature, or the classification a person gave it.
  const groups = {
    protocol: [] as { account: string; bani: bigint; basis: string }[],
    social: [] as { account: string; bani: bigint; basis: string }[],
    sponsorship: [] as { account: string; bani: bigint; basis: string }[],
  };
  let salaries = 0n;
  for (const row of rows) {
    const account = row.account;
    const bani = amountOf(row);
    const { nature, clause } = natureOf(account);
    const given = classified(books, account);
    const classification: AccountClassification | null = given?.answer.nature ?? null;
    const basis = given ? [given.answerId] : [];
    if (given) {
      const allowed = revenue(row) ? revenueClassifications : expenseClassifications;
      if (!allowed.includes(given.answer.nature)) {
        issues.push(
          block(
            'PROFIT_CLASSIFICATION',
            `Contul ${account} este ${revenue(row) ? 'de venituri' : 'de cheltuieli'}: clasificarea „${given.answer.nature}” nu i se potrivește.`,
            { account },
          ),
        );
        continue;
      }
    }
    if (nature === 'profit_tax') {
      add({
        row: 'P23',
        bani,
        accounts: [account],
        clause,
        text: 'Cheltuiala cu impozitul pe profit, nedeductibilă.',
        basis,
      });
      continue;
    }
    if (nature === 'depreciation' || nature === 'asset_disposal') {
      add({
        row: 'P28',
        bani,
        accounts: [account],
        clause,
        text:
          nature === 'depreciation'
            ? 'Amortizarea contabilă, înlocuită de amortizarea fiscală (rd. 11).'
            : 'Valoarea contabilă rămasă a mijloacelor fixe scoase din gestiune, înlocuită de valoarea fiscală rămasă (rd. 11).',
        basis,
      });
      continue;
    }
    if (nature === 'provision') {
      const deductible = options.determinations
        .filter(
          (item) =>
            item.account === account &&
            (item.rule === 'provision_deductible' || item.rule === 'receivables'),
        )
        .reduce(
          (total, item) =>
            total + (item.rule === 'receivables' ? 0n : parseMoney(item.amount, 'RON')),
          0n,
        );
      // Receivables are worked out below, with the register's share.
      add({
        row: 'P29',
        bani: bani - deductible,
        accounts: [account],
        clause,
        text: 'Provizioane și ajustări pentru depreciere peste limitele sau în alte condiții decât cele ale art. 26.',
        basis,
      });
      continue;
    }
    if (
      nature === 'provision_reversal' ||
      nature === 'taxable' ||
      nature === 'deductible' ||
      nature === 'salaries'
    ) {
      if (nature === 'salaries') salaries += bani;
      if (!given) continue;
    }
    if (nature === 'classify' && !given) {
      issues.push(
        questionIssue(
          'PROFIT_CLASSIFICATION',
          `Contul ${account} are ${ron(bani)} lei în perioadă: tratamentul lui fiscal depinde de natura cheltuielii sau a venitului (${clause.replace(`${CODE}:`, 'art. ')}). Întrebați cine o cunoaște (profit.account) și revizuiți propunerea citând răspunsul.`,
          {
            kind: 'profit.account',
            subject: { kind: 'account', id: account },
            params: { account },
          },
        ),
      );
      continue;
    }
    switch (classification) {
      case 'protocol':
        groups.protocol.push({ account, bani, basis: given!.answerId });
        break;
      case 'social':
        groups.social.push({ account, bani, basis: given!.answerId });
        break;
      case 'sponsorship':
        groups.sponsorship.push({ account, bani, basis: given!.answerId });
        add({
          row: 'P27',
          bani,
          accounts: [account],
          clause: `${CODE}:art.25(4)(i)`,
          text: 'Sponsorizarea, adăugată înapoi; se scade din impozit în limitele legii (rd. 43).',
          basis,
        });
        break;
      case 'fine':
        add({
          row: 'P25',
          bani,
          accounts: [account],
          clause: `${CODE}:art.25(4)(b)`,
          text: 'Dobânzi/majorări de întârziere, amenzi și penalități datorate autorităților.',
          basis,
        });
        break;
      case 'nondeductible':
        add({
          row: 'P33',
          bani,
          accounts: [account],
          clause: `${CODE}:${given!.answer.clause}`,
          text: 'Cheltuieli nedeductibile.',
          basis,
        });
        break;
      case 'dividend_ro':
        add({
          row: 'P171',
          bani,
          accounts: [account],
          clause: `${CODE}:art.23(a)`,
          text: 'Dividende primite de la o persoană juridică română, neimpozabile.',
          basis,
        });
        break;
      case 'nontaxable':
        add({
          row: 'P20',
          bani,
          accounts: [account],
          clause: `${CODE}:${given!.answer.clause}`,
          text: 'Venituri neimpozabile.',
          basis,
        });
        break;
      case 'vehicle': {
        if (/^68/.test(account)) {
          issues.push(
            block(
              'PROFIT_CLASSIFICATION',
              `Contul ${account} este de amortizare: limita de 50% nu cuprinde amortizarea (art. 25 alin. (3) lit. l)); a autoturismelor M1 o limitează art. 28 alin. (14).`,
              { account },
            ),
          );
          break;
        }
        const plate = normalizePlate(given!.answer.vehicle!);
        const use = books.vehicle(plate);
        if (!use) {
          issues.push(
            questionIssue(
              'VEHICLE_USE',
              `Contul ${account} ține cheltuielile vehiculului ${plate}: 50% din ele nu se deduc dacă vehiculul nu este folosit exclusiv în scopul activității economice (art. 25 alin. (3) lit. l)). Întrebați proprietarul (vehicle.use) și revizuiți propunerea citând răspunsul.`,
              {
                kind: 'vehicle.use',
                subject: { kind: 'vehicle', id: plate },
                params: { date: period.end },
              },
            ),
          );
          break;
        }
        if (use.deduction === 'limited')
          add({
            row: 'P33',
            bani: share(bani, vehicleRate, 'halfAwayFromZero'),
            accounts: [account],
            clause: `${CODE}:art.25(3)(l)`,
            text: `${vehicleRate}% din cheltuielile vehiculului ${plate}, folosit și în alte scopuri decât activitatea economică (TVA nededusă inclusă).`,
            basis: [...basis, use.answerId],
          });
        break;
      }
      default:
        break;
    }
  }

  // Stated amounts, within what each account holds.
  const held = new Map(rows.map((row) => [row.account, amountOf(row)]));
  const stated = new Map<string, bigint>();
  const reservation = (() => {
    try {
      return rules.param<ReceivableImpairment>(
        'ro.profit.receivables',
        'reporting_period_start',
        period.start,
      );
    } catch (error) {
      if (error instanceof RuleGapError) return null;
      throw error;
    }
  })();
  for (const [index, item] of options.determinations.entries()) {
    const bani = parseMoney(item.amount, 'RON');
    const path = `determinations.${index}`;
    const total = (stated.get(item.account) ?? 0n) + bani;
    stated.set(item.account, total);
    const available = held.get(item.account) ?? 0n;
    const nature = natureOf(item.account).nature;
    const expense = item.account.startsWith('6');
    const fits =
      item.rule === 'nontaxable'
        ? !expense
        : item.rule === 'provision_deductible' || item.rule === 'receivables'
          ? nature === 'provision'
          : expense;
    if (!fits || total > available || bani === 0n) {
      issues.push({
        ...block(
          'PROFIT_DETERMINATION',
          `Suma stabilită pentru contul ${item.account} (${item.rule}) depășește ce are contul în perioadă (${ron(available)} lei) sau nu i se potrivește.`,
        ),
        path,
      });
      continue;
    }
    const clause = `${CODE}:${item.clause}`;
    if (item.rule === 'receivables') {
      if (!reservation) {
        issues.push(
          block(
            'RULE_GAP',
            'Lipsește partea deductibilă a ajustărilor pentru creanțe (ro.profit.receivables).',
          ),
        );
        continue;
      }
      add({
        row: 'P29',
        bani: -share(bani, reservation.share, 'floor'),
        accounts: [item.account],
        clause,
        text: `${reservation.share}% din ajustările pentru creanțe neîncasate de peste ${reservation.overdueDays} de zile, negarantate, de la persoane neafiliate (baza ${ron(bani)} lei).`,
        basis: [item.evidenceId],
      });
    } else if (item.rule === 'nontaxable')
      add({
        row: 'P20',
        bani,
        accounts: [item.account],
        clause,
        text: 'Venituri neimpozabile stabilite.',
        basis: [item.evidenceId],
      });
    else if (item.rule === 'related_expenses')
      add({
        row: 'P32',
        bani,
        accounts: [item.account],
        clause,
        text: 'Cheltuieli aferente veniturilor neimpozabile.',
        basis: [item.evidenceId],
      });
    else if (item.rule === 'nondeductible')
      add({
        row: 'P33',
        bani,
        accounts: [item.account],
        clause,
        text: 'Cheltuieli nedeductibile stabilite.',
        basis: [item.evidenceId],
      });
  }
  // Dividends not taxed need their expenses allocated (art. 25 alin. (4) lit. e)), stated even
  // when zero, by a document that shows how.
  if (
    lines.some((line) => line.row === 'P171') &&
    !options.determinations.some((item) => item.rule === 'related_expenses')
  )
    issues.push(
      block(
        'PROFIT_RELATED_EXPENSES',
        'Dividendele neimpozabile cer stabilirea cheltuielilor aferente lor (art. 25 alin. (4) lit. e)): o metodă rațională de alocare sau ponderea în veniturile totale (determinations, related_expenses).',
      ),
    );

  // Protocol, within 2% of the accounting profit plus the profit tax and protocol expenses.
  const protocol = groups.protocol.reduce((total, item) => total + item.bani, 0n);
  const protocolLimit = positive(
    share(profitBeforeTax + protocol, protocolRate, 'halfAwayFromZero'),
  );
  add({
    row: 'P26',
    bani: positive(protocol - protocolLimit),
    accounts: groups.protocol.map((item) => item.account),
    clause: `${CODE}:art.25(3)(a)`,
    text: `Protocol ${ron(protocol)} lei peste limita de ${protocolRate}% (${ron(protocolLimit)} lei) din profitul contabil cu impozitul pe profit și protocolul adăugate.`,
    basis: groups.protocol.map((item) => item.basis),
  });
  // Social expenses, within 5% of the salaries.
  const benefits =
    options.socialBase === 'salaries_benefits'
      ? rows
          .filter((row) => /^(642|644)/.test(row.account))
          .reduce((total, row) => total + amountOf(row), 0n)
      : 0n;
  const social = groups.social.reduce((total, item) => total + item.bani, 0n);
  const socialLimit = positive(share(salaries + benefits, socialRate, 'halfAwayFromZero'));
  add({
    row: 'P33',
    bani: positive(social - socialLimit),
    accounts: groups.social.map((item) => item.account),
    clause: `${CODE}:art.25(3)(b)`,
    text: `Cheltuieli sociale ${ron(social)} lei peste ${socialRate}% din cheltuielile cu salariile (${ron(socialLimit)} lei).`,
    basis: groups.social.map((item) => item.basis),
  });

  // Fiscal depreciation, for every asset with an effect in the period.
  const deductions: AssetDeduction[] = [];
  let depreciation: ReturnType<typeof depreciationRulesOf> | null = null;
  const firstYearCap = () => depreciation!.acceleratedFirstYear;
  for (const asset of books.assets) {
    if (asset.commissionedOn > period.end) continue;
    if (asset.disposedOn && asset.disposedOn < period.start) continue;
    if (!asset.fiscal || !isFiscalBasis(asset.fiscal)) {
      issues.push(
        block(
          'ASSET_FISCAL',
          `${asset.number} ${asset.name}: înregistrați regimul fiscal al mijlocului fix (metoda, valoarea fiscală, durata normală; assets.recordFiscal), ca amortizarea fiscală să înlocuiască amortizarea contabilă (art. 28).`,
          { assetId: asset.id },
        ),
      );
      continue;
    }
    const basis = asset.fiscal;
    depreciation ??= depreciationRulesOf(rules, yearStart);
    const problems = basisIssues(asset, basis, depreciation, {
      superAccelerated: () =>
        rules.param<SuperAccelerated>(
          'ro.profit.superaccelerated',
          'asset_commissioning_date',
          asset.commissionedOn,
        ),
      threshold: () =>
        rules.param<string>(
          'ro.profit.asset_threshold',
          'asset_commissioning_date',
          asset.commissionedOn,
        ),
    });
    if (problems.length) {
      issues.push(...problems);
      continue;
    }
    const cap =
      basis.method === 'superaccelerated'
        ? rules.param<SuperAccelerated>(
            'ro.profit.superaccelerated',
            'asset_commissioning_date',
            asset.commissionedOn,
          ).firstYear
        : firstYearCap();
    deductions.push(
      assetDeduction(asset, basis, { from: period.start, to: period.end }, depreciation, cap),
    );
  }
  const full = (method: string) =>
    deductions
      .filter((item) => item.method === method)
      .reduce((total, item) => total + item.full, 0n);
  const fiscalDepreciation = deductions.reduce(
    (total, item) => total + item.depreciation + item.disposal + item.full,
    0n,
  );
  add({
    row: 'P11',
    bani: fiscalDepreciation,
    accounts: [],
    clause: `${CODE}:art.28`,
    text: `Amortizarea fiscală a ${deductions.length} mijloace fixe, cu valoarea fiscală rămasă a celor scoase din gestiune${deductions.some((item) => item.capped) ? ` (plafonul autoturismelor M1 a reținut ${ron(deductions.reduce((total, item) => total + item.capped, 0n))} lei)` : ''}.`,
    basis: deductions.map((item) => item.assetId),
  });
  for (const [row, method] of [
    ['P111', 'full_safety'],
    ['P112', 'full_medical'],
    ['P113', 'full_low_value'],
  ] as const)
    add({
      row,
      bani: full(method),
      accounts: [],
      clause: `${CODE}:art.28`,
      text: 'Deducere integrală la punerea în funcțiune.',
      basis: [],
    });

  // Elements similar to revenue: the favourable FX difference of the micro months.
  if (books.microFx !== null && books.microFx > 0n)
    add({
      row: 'P8',
      bani: books.microFx,
      accounts: ['765', '665'],
      clause: `${CODE}:art.53(2)(b)`,
      text: 'Diferența favorabilă de curs valutar din perioada de microîntreprindere a anului, element similar veniturilor în primul trimestru cu impozit pe profit.',
      basis: [],
    });

  // The legal reserve: 5% of the accounting profit plus the profit tax, until it reaches a fifth
  // of the capital.
  const reserveRoom = positive(
    share(books.capital, reserveRule.capitalShare, 'floor') - books.reserve,
  );
  const reserveDue =
    options.legalReserve && (options.annual || options.reserveAt !== 'annual_only');
  const reserveLimit = reserveDue
    ? positive(share(profitBeforeTax, reserveRule.rate, 'floor'))
    : 0n;
  const reserve = reserveLimit < reserveRoom ? reserveLimit : reserveRoom;
  add({
    row: 'P13',
    bani: reserve,
    accounts: ['1061'],
    clause: `${CODE}:art.26(1)(a)`,
    text: `Rezerva legală deductibilă: ${reserveRule.rate}% din profitul contabil cu impozitul pe profit adăugat, până la ${reserveRule.capitalShare}% din capitalul social (rămân ${ron(reserveRoom)} lei).`,
    basis: [],
  });

  // The rows, each rounded once to whole lei.
  const total = (row: D101Row) =>
    lines.filter((line) => line.row === row).reduce((sum, line) => sum + line.bani, 0n);
  const d = Object.fromEntries(d101Rows.map((row) => [row, 0n])) as D101Rows;
  d.P1 = toLei(operatingRevenue);
  d.P2 = toLei(operatingExpense);
  d.P4 = toLei(financialRevenue);
  d.P5 = toLei(financialExpense);
  for (const row of [
    'P8',
    'P11',
    'P111',
    'P112',
    'P113',
    'P13',
    'P171',
    'P20',
    'P23',
    'P25',
    'P26',
    'P27',
    'P28',
    'P29',
    'P32',
    'P33',
  ] as const)
    d[row] = toLei(positive(total(row)));
  d.P17 = d.P171;
  // The return derives the rest; the losses and the tax come next.
  let r = deriveD101Rows(d);
  let recovery: Recovery | null = null;
  if (books.losses === null)
    issues.push(block('PROFIT_LOSSES', 'Pierderile fiscale de recuperat nu sunt cunoscute.'));
  else if (books.losses.length) {
    recovery = recoverLosses(books.losses, period.year, r.P38a, rules, {
      ...(options.profitYears ? { profitYears: options.profitYears } : {}),
    });
    d.P39 = recovery.available;
    d.P39a = recovery.recovered;
  }
  r = deriveD101Rows(d);
  d.P411 = divRound(r.P40 * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');
  r = deriveD101Rows(d);
  // Sponsorship: the lesser of 0.75% of the turnover and 20% of the tax, each rounded down.
  const sponsored = groups.sponsorship.reduce((sum, item) => sum + item.bani, 0n);
  let limits: BridgeResult['bases']['sponsorshipLimits'] = null;
  if (sponsored > 0n && (options.annual || options.sponsorshipAt !== 'annual_only')) {
    limits = {
      turnover: divRound(
        positive(turnover) * parseScaled(sponsorship.turnover, 4),
        100_000_000n,
        'floor',
      ),
      tax: divRound((r.P41 - r.P42) * parseScaled(sponsorship.tax, 4), 1_000_000n, 'floor'),
    };
    const credit = [toLei(sponsored), limits.turnover, positive(limits.tax)].reduce((low, item) =>
      item < low ? item : low,
    );
    d.P431 = credit;
    d.P43 = credit;
  }
  d.P50 = options.declared;
  r = deriveD101Rows(d);
  return {
    rows: r,
    lines,
    issues,
    recovery,
    assets: deductions,
    bases: {
      profitBeforeTax,
      protocol,
      protocolLimit,
      social,
      socialLimit,
      salaries,
      turnover,
      reserveLimit,
      reserveRoom,
      sponsorship: sponsored,
      sponsorshipLimits: limits,
    },
  };
}

/** The rows as the position records them: strings, for JSON. */
export const rowsJson = (rows: D101Rows) =>
  Object.fromEntries(d101Rows.map((row) => [row, rows[row].toString()])) as Record<D101Row, string>;
export const rowsOf = (json: Record<string, string>) =>
  Object.fromEntries(d101Rows.map((row) => [row, BigInt(json[row] ?? '0')])) as D101Rows;
