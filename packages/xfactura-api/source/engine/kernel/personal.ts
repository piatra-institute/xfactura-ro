import type { DataClass } from 'xfactura-core/kernel';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { isValidCnp } from 'xfactura-core/ro/identifiers';

/*
 * Personal data in what a caller reads. CNPs are sealed at rest and opened only into the files
 * that must carry them (returns, a B2C invoice); a person's pay is in the books on the personnel
 * accounts. A reader who may not read the `personal` class sees no CNP, and one who may not read
 * `payroll` and `personal` sees no amount on a personnel account tied to a person.
 */

/** What a CNP becomes for a reader who may not read personal data, as `sales.preview` writes a
 * B2C buyer's: 13 asterisks. */
export const cnpMask = '*************';

/** The classes a person's pay belongs to: who earned, was withheld or is owed what. */
export const payClasses: readonly DataClass[] = ['payroll', 'personal'];

/** Fields that hold a party's identifier, where a CNP is masked whole. */
const identifierKeys = new Set([
  'taxId',
  'legalId',
  'vatId',
  'buyerTaxId',
  'cnp',
  'careCnp',
  'counterpartyTaxId',
  'supplierTaxId',
  'customerTaxId',
]);

const isCnp = (text: string) => isValidCnp(text.replace(/\s+/g, '').replace(/^RO/i, ''));
const thirteen = /(?<!\d)[1-9]\d{12}(?!\d)/g;

/**
 * A text with its CNPs masked: each run of 13 digits that passes a CNP's check digit or, with
 * `digits`, every run of 13 digits (a validator's message may quote one that fails it).
 */
export function maskCnpText(text: string, digits = false) {
  return text.replace(thirteen, (run) => (digits || isValidCnp(run) ? cnpMask : run));
}

/**
 * A JSON value with every CNP masked: an identifier field (`taxId`, `legalId`, `vatId`, …) that
 * holds one, with or without RO, and a CNP inside a citation's or a message's text. Codes that
 * merely have 13 digits elsewhere (an article's EAN) are left as they are.
 */
export function maskCnps<T>(value: T): T {
  const walk = (item: unknown, key?: string): unknown => {
    if (typeof item === 'string')
      return key && identifierKeys.has(key)
        ? isCnp(item)
          ? cnpMask
          : maskCnpText(item)
        : key === 'text' || key === 'message' || key === 'detail'
          ? maskCnpText(item)
          : item;
    if (Array.isArray(item)) return item.map((element) => walk(element, key));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, child]) => [
          name,
          walk(child, name),
        ]),
      );
    return item;
  };
  return walk(value) as T;
}

/** A personnel account (class 42: 421–428): its lines and items name the person paid, withheld
 * from or owed. */
export const personnelAccount = (account: string) => account.startsWith('42');

type AmountLine = {
  account: string;
  side: 'D' | 'C';
  amount: string;
  partyId?: string | undefined;
  openItem?: string | undefined;
  memo?: string | undefined;
  analytics?: Record<string, string> | undefined;
  currency?: unknown;
};

/**
 * Lines as a reader who may not read pay sees them: those on personnel accounts summed per
 * account and side, in lei, without the person (party, open item, memo, analytics), at the
 * place of the first; the others as they are.
 */
export function withoutPersons<Line extends AmountLine>(lines: Line[]): Line[] {
  const out: Line[] = [];
  const merged = new Map<string, { index: number; bani: bigint }>();
  for (const line of lines) {
    if (!personnelAccount(line.account)) {
      out.push(line);
      continue;
    }
    const key = `${line.account}/${line.side}`;
    const bani = parseMoney(line.amount, 'RON');
    const known = merged.get(key);
    if (known) {
      known.bani += bani;
      continue;
    }
    const {
      partyId: _party,
      openItem: _item,
      memo: _memo,
      analytics: _analytics,
      currency: _currency,
      ...rest
    } = line;
    merged.set(key, { index: out.length, bani });
    out.push(rest as Line);
  }
  for (const { index, bani } of merged.values())
    out[index] = { ...out[index]!, amount: formatMoney(bani, 'RON') };
  return out;
}

/*
 * Payments of pay (6 November 2026). A person's net pay, an advance or an aid leaves a bank or a
 * cash desk against a personnel account; the money registers (a statement's movements, the cash
 * register, the journal, a batch, a template's track record) showed who was paid, their IBAN and
 * what. For a reader who may not read pay, such a payment is a payment of salaries: no name, no
 * IBAN, no description or reference (each may name the person), and its amount only when it is
 * a salaries batch's total, which pays two people or more; one person's is withheld. A register
 * with balances (the cash register) shows the day's salaries in one row: its balances give the
 * total anyway.
 */

/** The personnel accounts whose payment is a person's pay: net pay (421), aid (423), advances
 * (425) and pay not collected (426). */
const payAccounts = ['421', '423', '425', '426'];
export const payAccount = (account: string) => payAccounts.includes(account.slice(0, 3));
/** A bank's (512x) or a cash desk's (531x) account: money that leaves or comes in. */
export const moneyAccount = (account: string) => /^(512|531)/.test(account);
/** What a payment of pay is called for a reader who may not read pay. */
export const salaryPayment = 'Plată salarii';

/**
 * Whether lines move money against pay, and how many people they pay: the distinct parties of
 * their lines on 421, 423, 425 or 426 (a line without a party counts as a person). Null when
 * they are not such a payment.
 */
export function payPayment(
  lines: readonly { account: string; partyId?: string | null | undefined }[],
): { persons: number } | null {
  if (!lines.some((line) => moneyAccount(line.account))) return null;
  const paid = lines.filter((line) => payAccount(line.account));
  if (!paid.length) return null;
  const parties = new Set(paid.map((line, index) => line.partyId ?? `line:${index}`));
  return { persons: parties.size };
}

/**
 * A payment of pay's lines as a reader who may not read pay sees them: its pay lines summed
 * without the person (`withoutPersons`), no memo, and, when it pays one person, no amount on its
 * pay and money lines (null): a salaries batch's total stands.
 */
export function paymentWithoutPersons<Line extends AmountLine>(
  lines: Line[],
  persons: number,
): (Omit<Line, 'amount' | 'memo'> & { amount: string | null })[] {
  type Shown = Omit<Line, 'amount' | 'memo'> & { amount: string | null };
  return withoutPersons(lines).map((line): Shown => {
    const { memo: _memo, ...rest } = line;
    if (persons > 1 || !(payAccount(line.account) || moneyAccount(line.account)))
      return rest as unknown as Shown;
    const { currency: _currency, ...hidden } = rest;
    return { ...hidden, amount: null } as unknown as Shown;
  });
}

/*
 * The sick pay the fund bears (4382): in a payroll that pays one person, its amount is that
 * person's sick pay, and its line alone says they were ill. A reader who may not read health data
 * sees such a payroll's 4382 folded into the expense (641): one line on 641 with both amounts,
 * marked `includes: ['4382']` whether or not there was sick pay, so that the entry still balances
 * and nothing tells it. A payroll of two people or more shows 4382 as booked: whose it is is not
 * told. The trial balance and the general ledger state 4382 as booked.
 */

/** Whether lines are a payroll's that pays one person: a salary expense (641) and net pay (421)
 * of a single party, no money moving. Read on the lines as booked, before any summing. */
export function singlePayroll(
  lines: readonly { account: string; partyId?: string | null | undefined }[],
) {
  if (lines.some((line) => moneyAccount(line.account))) return false;
  if (!lines.some((line) => line.account.startsWith('641'))) return false;
  const pay = lines.filter((line) => line.account.startsWith('421'));
  return pay.length > 0 && new Set(pay.map((line) => line.partyId ?? '')).size === 1;
}

/** A payroll's lines that pays one person (`singlePayroll`) as a reader who may not read health
 * data sees them (above). */
export function sickClaimWithoutHealth<
  Line extends { account: string; side: 'D' | 'C'; amount: string; memo?: string | undefined },
>(lines: Line[]): (Line & { includes?: string[] })[] {
  const cost = (account: string) => account.startsWith('641') || account.startsWith('4382');
  let net = 0n;
  for (const line of lines)
    if (cost(line.account)) {
      const bani = parseMoney(line.amount, 'RON');
      net += line.side === 'D' ? bani : -bani;
    }
  const out: (Line & { includes?: string[] })[] = [];
  for (const line of lines) {
    if (!cost(line.account)) {
      out.push(line);
      continue;
    }
    if (out.some((item) => item.includes)) continue;
    const { memo: _memo, ...rest } = line;
    out.push({
      ...(rest as Line),
      account: '641',
      side: net < 0n ? 'C' : 'D',
      amount: formatMoney(net < 0n ? -net : net, 'RON'),
      includes: ['4382'],
    });
  }
  return out;
}

type StoredItem = { account: string; currency: string; bani: string; minor: string };

/** A closing snapshot's open items as a reader who may not read pay sees them: those on personnel
 * accounts summed per account and currency, without their id and party. */
export function itemsWithoutPersons<Item extends StoredItem>(items: Item[]) {
  const merged = new Map<string, StoredItem>();
  const out: (Item | StoredItem)[] = [];
  for (const item of items) {
    if (!personnelAccount(item.account)) {
      out.push(item);
      continue;
    }
    const key = `${item.account}/${item.currency}`;
    const known = merged.get(key);
    if (known) {
      known.bani = String(BigInt(known.bani) + BigInt(item.bani));
      known.minor = String(BigInt(known.minor) + BigInt(item.minor));
      continue;
    }
    const { account, currency, bani, minor } = item;
    const sum = { account, currency, bani, minor };
    merged.set(key, sum);
    out.push(sum);
  }
  return out;
}

/**
 * What the year-end says of the personnel's balance confirmations (pct. 28) that are missing or
 * differ, without naming anyone: how many, on which account. The year close's findings say it so
 * to everyone, the review to a reader who may not read pay.
 */
export function personnelConfirmations(account: string, currency: string, count: number) {
  return `${count === 1 ? 'Confirmarea soldului unui membru' : `Confirmările soldurilor a ${count} membri`} ai personalului din ${account} (${currency}) ${count === 1 ? 'lipsește sau diferă' : 'lipsesc sau diferă'} de registre (pct. 28): le urmărește o persoană care poate citi datele salariale.`;
}

/** The year close's finding about partners' confirmations that names an employee: a preview
 * recorded before 6 November 2026 named each with their balance. */
const namesPersonnel = (finding: { code?: unknown; message?: unknown }) =>
  finding.code === 'YEAR_END_INVENTORY_PARTNERS' &&
  typeof finding.message === 'string' &&
  /\b42\d*\b/.test(finding.message) &&
  !finding.message.includes('ai personalului');

/**
 * A reviewed action's preview as a reader who may not read pay sees it: the year close's closing
 * snapshot (`years.close`) holds each open item at the year's end, an employee's unpaid pay among
 * them, and its findings an employee's balance that did not confirm.
 */
export function previewWithoutPersons(operation: string, preview: unknown) {
  if (operation !== 'years.close' || !preview || typeof preview !== 'object') return preview;
  const value = preview as {
    closing?: { items?: StoredItem[] };
    findings?: { code?: unknown; message?: unknown }[];
  };
  const closing = value.closing;
  return {
    ...(preview as Record<string, unknown>),
    ...(Array.isArray(closing?.items)
      ? { closing: { ...closing, items: itemsWithoutPersons(closing.items) } }
      : {}),
    ...(Array.isArray(value.findings)
      ? {
          findings: value.findings.map((finding) =>
            namesPersonnel(finding)
              ? {
                  ...finding,
                  message: personnelConfirmations(
                    /\b(42\d*)\b/.exec(finding.message as string)![1]!,
                    'RON',
                    1,
                  ),
                }
              : finding,
          ),
        }
      : {}),
  };
}

/*
 * Health data (GDPR art. 9): who was on medical leave, with which certificate, indemnity code and
 * diagnosis, and work accidents. It is redacted for every caller who may not read the `health`
 * class (`Commands.disclosable`): a viewer, and an agent whose grant names no operation declaring
 * it.
 */

/** The classes a reader of health data needs. */
export const healthClasses: readonly DataClass[] = ['health'];

/** Personal data sealed at rest: AES-256-GCM under a key derived from the installation's secret,
 * bound to the company (`Sealer`, modules/payroll.ts). */
export interface Seal {
  seal(companyId: string, text: string): string;
  open(companyId: string, sealed: string): string;
}

/*
 * Sick leave at rest (6 November 2026). A payroll line keeps each medical certificate it paid
 * sealed whole (its series and number, indemnity code, dates, where it was prescribed, the codes
 * D112 asks; the diagnosis and a cared-for person's CNP sealed inside it as before): the next
 * month's computation opens them to continue an episode, the D112 writer to declare them. Its
 * issues about a certificate keep their mark without their code and message, opened for a
 * reader of health data. An answer about a month's absences keeps each absence sealed but for the
 * medical certificate's file, which classification and the worklist read.
 */

/** A record sealed whole: `{ sealed }`, and what stays in clear beside it. */
export type Sealed<Clear extends object = object> = Clear & { sealed: string };
const isSealed = (value: unknown): value is Sealed =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as { sealed?: unknown }).sealed === 'string';

/** Records sealed whole, each kept as `{ sealed, ...clear }`; one sealed already is kept. */
export function sealRecords<Item extends object>(
  seal: Seal,
  companyId: string,
  records: readonly (Item | Sealed)[],
  clear: (record: Item) => object = () => ({}),
): Sealed[] {
  return records.map((record) =>
    isSealed(record)
      ? record
      : { ...clear(record as Item), sealed: seal.seal(companyId, JSON.stringify(record)) },
  );
}

/** Records as they were sealed (`sealRecords`); one never sealed is returned as it is. */
export function openRecords<Item extends object>(
  seal: Seal,
  companyId: string,
  records: readonly (Item | Sealed)[] | undefined,
): Item[] {
  return (records ?? []).map((record) =>
    isSealed(record) ? (JSON.parse(seal.open(companyId, record.sealed)) as Item) : (record as Item),
  );
}

type HealthIssue = { code: string; message: string; health?: true };
/** A run's issues as they are kept: those about sick leave (marked `health`, or `SICK_*` before
 * the mark) sealed, with their mark. */
export function sealIssues<Issue extends HealthIssue>(
  seal: Seal,
  companyId: string,
  issues: readonly (Issue | Sealed<{ health: true }>)[],
) {
  return issues.map((issue) =>
    isSealed(issue) || !(issue.health || issue.code.startsWith('SICK_'))
      ? issue
      : {
          health: true as const,
          sealed: seal.seal(
            companyId,
            JSON.stringify({ code: issue.code, message: issue.message }),
          ),
        },
  );
}

/** A run's issues opened for a reader of health data (`sealIssues`). */
export function openIssues(
  seal: Seal,
  companyId: string,
  issues: readonly (HealthIssue | Sealed<{ health: true }>)[],
): HealthIssue[] {
  return issues.map((issue) =>
    isSealed(issue)
      ? {
          ...(JSON.parse(seal.open(companyId, issue.sealed)) as HealthIssue),
          health: true as const,
        }
      : (issue as HealthIssue),
  );
}

/** The answers kept sealed at rest, by question kind: each absence of a month, but for the
 * medical certificate's file. */
const sealedAnswers: Record<string, { list: string; clear: string[] }> = {
  'payroll.absences': { list: 'absences', clear: ['certificateEvidenceId'] },
};

/** An answer's value as it is kept (above); other kinds as they are. */
export function sealAnswer(seal: Seal, companyId: string, kind: string, value: unknown): unknown {
  const sealed = sealedAnswers[kind];
  const items = (value as Record<string, unknown> | null)?.[sealed?.list ?? ''];
  if (!sealed || !Array.isArray(items)) return value;
  return {
    ...(value as object),
    [sealed.list]: sealRecords(seal, companyId, items as object[], (item) =>
      Object.fromEntries(
        sealed.clear.flatMap((key) =>
          (item as Record<string, unknown>)[key] === undefined
            ? []
            : [[key, (item as Record<string, unknown>)[key]]],
        ),
      ),
    ),
  };
}

/** An answer's value as it was answered, for a reader who may read it; without the seal (an
 * engine without the installation's secret), as it is kept. */
export function openAnswer(
  seal: Seal | undefined,
  companyId: string,
  kind: string,
  value: unknown,
): unknown {
  const sealed = sealedAnswers[kind];
  const items = (value as Record<string, unknown> | null)?.[sealed?.list ?? ''];
  if (!seal || !sealed || !Array.isArray(items)) return value;
  return { ...(value as object), [sealed.list]: openRecords(seal, companyId, items as object[]) };
}

/** What a redacted sick-leave issue says instead: that one exists, not whose or which. */
export const healthIssue = {
  code: 'HEALTH_REDACTED',
  message:
    'O problemă privind un concediu medical (date de sănătate), pe care această identitate nu o poate citi: o vede un proprietar sau un revizor.',
} as const;

/** A payroll line's issues as a reader who may not read health data sees them: those of its
 * medical certificates (marked `health`; before the mark, `SICK_*`), which name the certificate
 * and its code, replaced by `healthIssue`. */
export function issuesWithoutHealth<Issue extends { code: string; message: string; health?: true }>(
  issues: Issue[],
): (Issue | typeof healthIssue)[] {
  return issues.map((issue) =>
    issue.health || issue.code.startsWith('SICK_') ? healthIssue : issue,
  );
}

type Difference = { section: string; id: string; closing: unknown; opening: unknown };

/**
 * A year's opening checked against its close (`years.opening`) as a reader who may not read pay
 * sees it: the differences of open items on personnel accounts summed per account and currency,
 * on each side, without the item and its person; the others as they are.
 */
export function differencesWithoutPersons<Item extends Difference>(differences: Item[]) {
  const out: (Item | Difference)[] = [];
  const merged = new Map<string, { closing: StoredItem; opening: StoredItem }>();
  const add = (sum: StoredItem, item: StoredItem | null) => {
    if (!item) return;
    sum.bani = String(BigInt(sum.bani) + BigInt(item.bani));
    sum.minor = String(BigInt(sum.minor) + BigInt(item.minor));
  };
  for (const difference of differences) {
    const closing = difference.closing as StoredItem | null;
    const opening = difference.opening as StoredItem | null;
    const item = closing ?? opening;
    if (difference.section !== 'items' || !item || !personnelAccount(item.account)) {
      out.push(difference);
      continue;
    }
    const id = `${item.account}/${item.currency}`;
    let sums = merged.get(id);
    if (!sums) {
      const zero = () => ({
        account: item.account,
        currency: item.currency,
        bani: '0',
        minor: '0',
      });
      sums = { closing: zero(), opening: zero() };
      merged.set(id, sums);
      out.push({ section: 'items', id, ...sums });
    }
    add(sums.closing, closing);
    add(sums.opening, opening);
  }
  return out;
}
