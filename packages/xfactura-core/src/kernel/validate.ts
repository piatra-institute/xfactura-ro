import { INT64_MAX, isSupportedCurrency, LEDGER_CURRENCY, parseDecimal } from '../money';
import { isLocalDate, type LocalDate } from '../time';
import {
  openItemKinds,
  type ControlKind,
  type Effect,
  type Issue,
  type JsonValue,
  type OpenItemKind,
  type Side,
} from './effect';

export const accountCodePattern = /^[1-9]\d{1,3}(?:\.[A-Z0-9_-]{1,24}){0,4}$/;

export interface AccountInfo {
  code: string;
  postable: boolean;
  controlKind: ControlKind | null;
  validFrom: LocalDate;
  validTo: LocalDate | null;
}

/** An open item as recorded before this effect, taken from the proposal's read-set. */
export interface OpenItemInfo {
  id: string;
  kind: OpenItemKind;
  controlAccount: string;
  partyId: string;
  currency: string;
  normalSide: Side;
  mayReverse: boolean;
  balanceBani: bigint;
  balanceMinor: bigint;
}

export interface EffectContext {
  account(code: string): AccountInfo | undefined;
  openItem(id: string): OpenItemInfo | undefined;
}

const isOpenItemKind = (kind: ControlKind | null): kind is OpenItemKind =>
  (openItemKinds as readonly string[]).includes(kind ?? '');
const absolute = (value: bigint) => (value < 0n ? -value : value);

function block(code: string, message: string, path?: string, details?: JsonValue): Issue {
  return {
    code,
    severity: 'block',
    message,
    ...(path === undefined ? {} : { path }),
    ...(details === undefined ? {} : { details }),
  };
}

function validRate(rate: string) {
  try {
    return parseDecimal(rate).numerator > 0n;
  } catch {
    return false;
  }
}

/**
 * Structural checks every effect must pass before it can be proposed, independent of the
 * treatment that produced it. The database invariants repeat the essential ones at posting.
 */
export function validateEffect(effect: Effect, context: EffectContext): Issue[] {
  const issues: Issue[] = [];
  if (effect.schema !== 'effect@1')
    issues.push(block('EFFECT_SCHEMA', 'Formatul efectului contabil nu este cunoscut.'));
  if (!isLocalDate(effect.date)) {
    issues.push(block('EFFECT_DATE', 'Data înregistrării nu este validă.', 'date'));
    return issues;
  }
  if (effect.journalClass === 'general' && effect.lines.length < 2)
    issues.push(block('LINES_MIN', 'O notă contabilă are cel puțin două linii.', 'lines'));
  if (effect.journalClass === 'memo' && effect.lines.length > 0)
    issues.push(block('MEMO_LINES', 'O înregistrare memorială nu are linii contabile.', 'lines'));

  const created = new Map<string, OpenItemInfo>();
  effect.openItems.forEach((item, index) => {
    const path = `openItems.${index}`;
    if (created.has(item.ref) || context.openItem(item.ref))
      issues.push(
        block('OPEN_ITEM_DUPLICATE', 'Poziția deschisă este definită de două ori.', path),
      );
    if (!isSupportedCurrency(item.currency))
      issues.push(block('OPEN_ITEM_CURRENCY', 'Moneda poziției nu este acceptată.', path));
    created.set(item.ref, { ...item, id: item.ref, balanceBani: 0n, balanceMinor: 0n });
  });
  const itemFor = (reference: string) => created.get(reference) ?? context.openItem(reference);

  let debit = 0n;
  let credit = 0n;
  const deltas = new Map<string, { bani: bigint; minor: bigint }>();
  const taxLines = new Set<number>();
  effect.lines.forEach((line, index) => {
    const path = `lines.${index}`;
    if (line.bani === 0n) issues.push(block('LINE_ZERO', 'Linia nu are sumă.', path));
    if (absolute(line.bani) > INT64_MAX)
      issues.push(block('LINE_RANGE', 'Suma depășește limita de stocare.', path));
    if (line.side === 'D') debit += line.bani;
    else credit += line.bani;

    const account = accountCodePattern.test(line.account)
      ? context.account(line.account)
      : undefined;
    if (!account) {
      issues.push(block('ACCOUNT_UNKNOWN', `Contul ${line.account} nu există.`, path));
      return;
    }
    if (!account.postable)
      issues.push(
        block('ACCOUNT_NOT_POSTABLE', `Contul ${line.account} nu primește înregistrări.`, path),
      );
    if (
      account.validFrom > effect.date ||
      (account.validTo !== null && account.validTo < effect.date)
    )
      issues.push(
        block('ACCOUNT_DATE', `Contul ${line.account} nu este valabil la această dată.`, path),
      );

    if (line.currency) {
      const { code, minor, rate } = line.currency;
      if (!isSupportedCurrency(code) || code === LEDGER_CURRENCY)
        issues.push(block('LINE_CURRENCY', 'Moneda liniei nu este acceptată.', path));
      if (!validRate(rate)) issues.push(block('LINE_RATE', 'Cursul liniei nu este valid.', path));
      if (minor !== 0n && minor < 0n !== line.bani < 0n)
        issues.push(
          block('LINE_CURRENCY_SIGN', 'Suma în valută are alt semn decât suma în lei.', path),
        );
    }

    if (isOpenItemKind(account.controlKind)) {
      const item = line.openItem === undefined ? undefined : itemFor(line.openItem);
      if (!line.openItem)
        issues.push(
          block(
            'CONTROL_OPEN_ITEM',
            `Linia pe contul ${line.account} cere o poziție deschisă.`,
            path,
          ),
        );
      else if (!item)
        issues.push(block('OPEN_ITEM_UNKNOWN', 'Poziția deschisă nu este disponibilă.', path));
      else {
        if (item.kind !== account.controlKind || item.controlAccount !== line.account)
          issues.push(block('OPEN_ITEM_ACCOUNT', 'Poziția deschisă aparține altui cont.', path));
        if (line.partyId !== undefined && line.partyId !== item.partyId)
          issues.push(block('OPEN_ITEM_PARTY', 'Poziția deschisă aparține altui partener.', path));
        if ((line.currency?.code ?? LEDGER_CURRENCY) !== item.currency)
          issues.push(
            block('OPEN_ITEM_CURRENCY', 'Linia are altă monedă decât poziția deschisă.', path),
          );
        const sign = line.side === 'D' ? 1n : -1n;
        const delta = deltas.get(line.openItem) ?? { bani: 0n, minor: 0n };
        delta.bani += sign * line.bani;
        delta.minor +=
          sign * (item.currency === LEDGER_CURRENCY ? line.bani : (line.currency?.minor ?? 0n));
        deltas.set(line.openItem, delta);
      }
    } else if (line.openItem !== undefined)
      issues.push(
        block('OPEN_ITEM_NOT_CONTROL', `Contul ${line.account} nu are poziții deschise.`, path),
      );

    if (account.controlKind === 'tax') taxLines.add(index);
    else if (line.taxSettlement)
      issues.push(
        block('TAX_SETTLEMENT_ACCOUNT', 'Regularizarea de taxă se face pe un cont de taxă.', path),
      );
  });
  if (debit !== credit)
    issues.push(
      block('UNBALANCED', 'Totalul debit trebuie să fie egal cu totalul credit.', 'lines', {
        debit: debit.toString(),
        credit: credit.toString(),
      }),
    );

  for (const reference of created.keys())
    if (!deltas.has(reference))
      issues.push(
        block('OPEN_ITEM_UNUSED', 'Poziția deschisă nu are nicio înregistrare.', 'openItems'),
      );
  const after = new Map<string, { bani: bigint; minor: bigint }>();
  for (const [reference, delta] of deltas) {
    const item = itemFor(reference)!;
    const bani = item.balanceBani + delta.bani;
    const minor = item.balanceMinor + delta.minor;
    after.set(reference, { bani, minor });
    const reversed = item.normalSide === 'D' ? bani < 0n || minor < 0n : bani > 0n || minor > 0n;
    if (reversed && !item.mayReverse)
      issues.push(
        block('OPEN_ITEM_REVERSED', 'Operațiunea depășește soldul poziției deschise.', undefined, {
          openItem: reference,
        }),
      );
    if (item.currency !== LEDGER_CURRENCY && minor === 0n && bani !== 0n)
      issues.push(
        block('OPEN_ITEM_RESIDUAL', 'Poziția închisă în valută are sold rămas în lei.', undefined, {
          openItem: reference,
        }),
      );
  }

  const taxKeys = new Set<string>();
  const booked = new Map<number, { total: bigint; direction: 'output' | 'input' }>();
  effect.taxEntries.forEach((entry, index) => {
    const path = `taxEntries.${index}`;
    if (taxKeys.has(entry.key))
      issues.push(block('TAX_ENTRY_DUPLICATE', 'Intrarea fiscală este duplicată.', path));
    taxKeys.add(entry.key);
    if (
      !isLocalDate(entry.taxPoint) ||
      (entry.exigibility !== null && !isLocalDate(entry.exigibility))
    )
      issues.push(block('TAX_ENTRY_DATE', 'Datele intrării fiscale nu sunt valide.', path));
    if (entry.line === undefined) {
      if (entry.ledgerBani !== 0n)
        issues.push(
          block(
            'TAX_ENTRY_LINE',
            'Intrarea fiscală fără linie nu poate avea sumă înregistrată.',
            path,
          ),
        );
      return;
    }
    if (!taxLines.has(entry.line)) {
      issues.push(
        block(
          'TAX_ENTRY_LINE',
          'Intrarea fiscală indică o linie care nu este pe un cont de taxă.',
          path,
        ),
      );
      return;
    }
    const group = booked.get(entry.line) ?? { total: 0n, direction: entry.direction };
    if (group.direction !== entry.direction)
      issues.push(block('TAX_ENTRY_DIRECTION', 'O linie de taxă are o singură direcție.', path));
    group.total += entry.ledgerBani;
    booked.set(entry.line, group);
  });
  for (const index of taxLines) {
    const line = effect.lines[index]!;
    const group = booked.get(index);
    const path = `lines.${index}`;
    if (!group) {
      if (!line.taxSettlement)
        issues.push(
          block(
            'TAX_LINE_UNEXPLAINED',
            `Linia pe contul ${line.account} cere intrări fiscale.`,
            path,
          ),
        );
      continue;
    }
    if (line.taxSettlement)
      issues.push(
        block('TAX_LINE_AMBIGUOUS', 'Linia de taxă este fie operațiune, fie regularizare.', path),
      );
    const positive = group.direction === 'output' ? 'C' : 'D';
    const amount = line.side === positive ? line.bani : -line.bani;
    if (amount !== group.total)
      issues.push(
        block('TAX_LINE_MISMATCH', 'Suma liniei de taxă diferă de intrările fiscale.', path, {
          line: amount.toString(),
          entries: group.total.toString(),
        }),
      );
  }

  effect.schedules.forEach((schedule, index) => {
    const path = `schedules.${index}`;
    const item = itemFor(schedule.openItem);
    if (!item) {
      issues.push(block('SCHEDULE_OPEN_ITEM', 'Graficul nu are o poziție deschisă validă.', path));
      return;
    }
    const keys = new Set(schedule.rows.map((row) => row.key));
    if (keys.size !== schedule.rows.length || schedule.rows.length === 0)
      issues.push(block('SCHEDULE_ROWS', 'Rândurile graficului lipsesc sau sunt duplicate.', path));
    schedule.rows.forEach((row, rowIndex) => {
      const account = context.account(row.counterAccount);
      if (!isLocalDate(row.due) || row.bani <= 0n || !account?.postable)
        issues.push(
          block('SCHEDULE_ROW', 'Rândul graficului nu este valid.', `${path}.rows.${rowIndex}`),
        );
    });
    // A new item's schedule plans its balance, in its currency: the rows on its own account (a
    // loan's repayments, beside the interest it books elsewhere) or, without such rows, all of
    // them (a deferral's releases).
    const balance = after.get(schedule.openItem);
    if (created.has(schedule.openItem) && balance) {
      const amount = item.currency === LEDGER_CURRENCY ? balance.bani : balance.minor;
      const remaining = item.normalSide === 'D' ? amount : -amount;
      const own = schedule.rows.filter((row) => row.counterAccount === item.controlAccount);
      const total = (own.length ? own : schedule.rows).reduce((sum, row) => sum + row.bani, 0n);
      if (total !== remaining)
        issues.push(
          block('SCHEDULE_TOTAL', 'Totalul graficului diferă de soldul poziției.', path, {
            schedule: total.toString(),
            balance: remaining.toString(),
          }),
        );
    }
  });
  return issues;
}
