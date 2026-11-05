import { INT64_MAX, isSupportedCurrency, LEDGER_CURRENCY, parseDecimal } from '../money';
import { isLocalDate, type LocalDate } from '../time';
import {
  isStockAccount,
  openItemKinds,
  stockLayerMethods,
  type ControlKind,
  type Effect,
  type Issue,
  type JsonValue,
  type OpenItemKind,
  type Side,
  type StockLayerMethod,
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

/** A stock layer as recorded before this effect, taken from the proposal's read-set. */
export interface StockLayerInfo {
  id: string;
  item: string;
  warehouse: string;
  account: string;
  method: StockLayerMethod;
  mayGoNegative: boolean;
  /** Thousandths of the item's unit. */
  quantity: bigint;
  bani: bigint;
}

/** An item of the stock catalogue: the stock account its layers are on, its unit of measure. */
export interface StockItemInfo {
  id: string;
  account: string;
  unit: string;
}

export interface EffectContext {
  account(code: string): AccountInfo | undefined;
  openItem(id: string): OpenItemInfo | undefined;
  /** The layers the effect's moves consume or add to, as the read-set holds them. */
  stockLayer?(id: string): StockLayerInfo | undefined;
  /** The catalogue's items and the warehouses the effect names. */
  stockItem?(id: string): StockItemInfo | undefined;
  warehouse?(id: string): boolean;
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
  const moves = effect.stockMoves ?? [];
  if (
    (effect.schema !== 'effect@1' && effect.schema !== 'effect@2') ||
    (effect.schema === 'effect@1' &&
      (effect.stockMoves !== undefined || effect.stockLayers !== undefined)) ||
    (effect.schema === 'effect@2' && moves.length === 0)
  )
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

    // An account kept at retail price (G2) takes only lines tagged with their warehouse, which
    // the retail treatments write: never a general entry's, never VAT on collection's.
    if (account.controlKind === 'retail' && !line.analytics?.item?.startsWith('retail:'))
      issues.push(
        block(
          'RETAIL_ACCOUNT',
          `Contul ${line.account} ține mărfurile unei gestiuni la preț cu amănuntul: se înregistrează doar prin tratamentele metodei (retail.*, recepția cu retail).`,
          path,
        ),
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

  issues.push(...validateStock(effect, context));

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

/**
 * The stock register's part of an effect (`effect@2`): the layers it creates are on their item's
 * stock account, in a known warehouse, and used; each move enters or leaves a layer of its own
 * item, warehouse and account; the moves naming a line add up to its signed amount (debit
 * positive), and those naming none move goods between warehouses, netting to zero; no layer ends
 * below zero unless it may, nor holds a value without a quantity.
 */
function validateStock(effect: Effect, context: EffectContext): Issue[] {
  const issues: Issue[] = [];
  const moves = effect.stockMoves ?? [];
  const created = new Map<string, StockLayerInfo>();
  (effect.stockLayers ?? []).forEach((layer, index) => {
    const path = `stockLayers.${index}`;
    if (created.has(layer.ref) || context.stockLayer?.(layer.ref))
      issues.push(block('STOCK_LAYER_DUPLICATE', 'Lotul de stoc este definit de două ori.', path));
    if (!isStockAccount(layer.account))
      issues.push(
        block('STOCK_ACCOUNT', `Contul ${layer.account} nu este un cont de stocuri.`, path),
      );
    const item = context.stockItem?.(layer.item);
    if (!item) issues.push(block('STOCK_ITEM_UNKNOWN', 'Articolul de stoc nu există.', path));
    else if (item.account !== layer.account)
      issues.push(
        block(
          'STOCK_ITEM_ACCOUNT',
          `Articolul se ține în contul ${item.account}, nu în ${layer.account}.`,
          path,
        ),
      );
    if (!context.warehouse?.(layer.warehouse))
      issues.push(block('STOCK_WAREHOUSE_UNKNOWN', 'Gestiunea nu există.', path));
    if (
      !(stockLayerMethods as readonly string[]).includes(layer.method) ||
      !isLocalDate(layer.date)
    )
      issues.push(block('STOCK_LAYER', 'Lotul de stoc nu este valid.', path));
    created.set(layer.ref, { ...layer, id: layer.ref, quantity: 0n, bani: 0n });
  });
  const layerOf = (id: string) => created.get(id) ?? context.stockLayer?.(id);

  const used = new Set<string>();
  const explained = new Map<number, bigint>();
  const transfers = new Map<string, bigint>();
  const transferred = new Map<string, bigint>();
  const deltas = new Map<string, { quantity: bigint; bani: bigint }>();
  moves.forEach((move, index) => {
    const path = `stockMoves.${index}`;
    if (move.quantity === 0n && move.bani === 0n)
      issues.push(block('STOCK_MOVE_ZERO', 'Mișcarea de stoc nu are cantitate sau valoare.', path));
    if (move.quantity !== 0n && move.bani !== 0n && move.quantity < 0n !== move.bani < 0n)
      issues.push(
        block('STOCK_MOVE_SIGN', 'Cantitatea și valoarea mișcării au semne diferite.', path),
      );
    if (absolute(move.quantity) > INT64_MAX || absolute(move.bani) > INT64_MAX)
      issues.push(block('STOCK_MOVE_RANGE', 'Mișcarea depășește limita de stocare.', path));
    const account = context.account(move.account);
    if (!isStockAccount(move.account) || !account?.postable)
      issues.push(
        block('STOCK_ACCOUNT', `Contul ${move.account} nu este un cont de stocuri.`, path),
      );
    const layer = layerOf(move.layer);
    if (!layer) {
      issues.push(block('STOCK_LAYER_UNKNOWN', 'Lotul de stoc nu este disponibil.', path));
      return;
    }
    used.add(move.layer);
    if (
      layer.item !== move.item ||
      layer.warehouse !== move.warehouse ||
      layer.account !== move.account
    )
      issues.push(
        block(
          'STOCK_MOVE_LAYER',
          'Mișcarea este pe alt articol, gestiune sau cont decât lotul.',
          path,
        ),
      );
    const delta = deltas.get(move.layer) ?? { quantity: 0n, bani: 0n };
    delta.quantity += move.quantity;
    delta.bani += move.bani;
    deltas.set(move.layer, delta);
    if (move.line === undefined) {
      transfers.set(move.account, (transfers.get(move.account) ?? 0n) + move.bani);
      const key = `${move.account}|${move.item}`;
      transferred.set(key, (transferred.get(key) ?? 0n) + move.quantity);
      return;
    }
    const line = effect.lines[move.line];
    if (!line || line.account !== move.account)
      issues.push(
        block('STOCK_MOVE_LINE', 'Mișcarea indică o linie care nu este pe contul ei.', path),
      );
    else explained.set(move.line, (explained.get(move.line) ?? 0n) + move.bani);
  });
  for (const [index, total] of explained) {
    const line = effect.lines[index]!;
    const signed = line.side === 'D' ? line.bani : -line.bani;
    if (total !== signed)
      issues.push(
        block(
          'STOCK_LINE_MISMATCH',
          'Valoarea mișcărilor de stoc diferă de suma liniei.',
          `lines.${index}`,
          { line: signed.toString(), moves: total.toString() },
        ),
      );
  }
  if ([...transfers.values(), ...transferred.values()].some((total) => total !== 0n))
    issues.push(
      block(
        'STOCK_TRANSFER_UNBALANCED',
        'Mișcările dintre gestiuni nu se compensează pe cont și pe articol.',
        'stockMoves',
      ),
    );
  for (const reference of created.keys())
    if (!used.has(reference))
      issues.push(
        block('STOCK_LAYER_UNUSED', 'Lotul de stoc nu are nicio mișcare.', 'stockLayers'),
      );
  for (const [reference, delta] of deltas) {
    const layer = layerOf(reference)!;
    const quantity = layer.quantity + delta.quantity;
    const bani = layer.bani + delta.bani;
    if (!layer.mayGoNegative && (quantity < 0n || bani < 0n))
      issues.push(
        block('STOCK_NEGATIVE', 'Stocul lotului ar deveni negativ.', undefined, {
          layer: reference,
          quantity: quantity.toString(),
          bani: bani.toString(),
        }),
      );
    else if (quantity === 0n && bani !== 0n)
      issues.push(
        block('STOCK_RESIDUAL', 'Lotul epuizat ar rămâne cu valoare.', undefined, {
          layer: reference,
          bani: bani.toString(),
        }),
      );
  }
  return issues;
}
