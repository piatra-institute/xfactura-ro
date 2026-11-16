import type { D406FiledTax, D406FiledTransaction } from 'xfactura-core/ro/saft/read';
import { d406CodeReadings, type D406CodeReading } from 'xfactura-core/ro/saft/tax-code-readings';
import { d406CollectedWithAcquisition } from 'xfactura-core/ro/saft/tax-codes';
import type { LocalDate } from 'xfactura-core/time';
import { add } from '../compare/decimal';
import type { TaxSupplement } from '../compare/journals';
import type { MigrationJournalInput } from '../treatments/journal';
import { money, negate } from './amounts';

type TaxEntry = MigrationJournalInput['taxEntries'][number];
type Direction = 'input' | 'output';
type Family = '4426' | '4427' | '4428';
export type ReadingTable = (taxCode: string) => readonly D406CodeReading[];

/**
 * What a TaxInformation block of SAGA's D406 is:
 * - `placeholder`: TaxType 000 with no amount, ANAF's code for a line without tax relevance;
 * - `closing`: TaxCode 380200, "Notă închidere TVA", marking the VAT closing note;
 * - `marker`: a block with a zero amount and no base, naming the code of the line it sits on
 *   (SAGA repeats an operation's code on its 4426/4427/4428 lines, and marks a reversal of a
 *   deduction, a cash-VAT release, an import's VAT or an exempt purchase this way);
 * - `operation`: a VAT block with an amount or a base, the tax facts of an operation;
 * - `other`: any other tax with an amount or a base (a tax withheld at source), which
 *   `migration.journal` has no place for.
 */
export type BlockRole = 'placeholder' | 'closing' | 'marker' | 'operation' | 'other';

export function blockRole(tax: D406FiledTax): BlockRole {
  const zero = tax.amount !== undefined && money(tax.amount) === '0.00';
  if (tax.type === '000' && zero) return 'placeholder';
  if (tax.type === '300' && tax.code === '380200') return 'closing';
  if (zero && tax.base === undefined) return 'marker';
  return tax.type === '300' ? 'operation' : 'other';
}

const familyOf = (account: string | undefined): Family | null => {
  const synthetic = account?.split('.')[0];
  return synthetic === '4426' || synthetic === '4427' || synthetic === '4428' ? synthetic : null;
};

/** Whether some reading of a VAT code reports it in a row of the VAT return (D300). */
const returnRelevant = (tax: D406FiledTax, table: ReadingTable) =>
  tax.type === '300' &&
  table(tax.code ?? '').some((reading) => 'd300' in reading && reading.d300 !== '');

/**
 * The filed facts the journal comparison compares, per line: operations, other taxes, and a VAT
 * marker off the VAT accounts whose code a return reports (an exempt purchase's 308302, an
 * import's 301201). Such a marker states no base, so the engine holds none for it and the
 * comparison shows the missing tax fact.
 */
export function comparedTaxes(
  transaction: D406FiledTransaction,
  accounts: readonly (string | undefined)[],
  table: ReadingTable = d406CodeReadings,
): D406FiledTax[][] {
  return transaction.lines.map((line, l) =>
    (line.tax ?? []).filter((tax) => {
      const role = blockRole(tax);
      return (
        role === 'operation' ||
        role === 'other' ||
        (role === 'marker' && !familyOf(accounts[l]) && returnRelevant(tax, table))
      );
    }),
  );
}

export type TaxRefusal = { code: string; message: string };
export type TaxLine = { account: string | undefined; side: 'D' | 'C'; amount: string };
export type TaxTranslation = {
  /** Line index to its period settlement marker, on a VAT closing note. */
  settlements: Map<number, { tax: string; period: string }>;
  entries: TaxEntry[];
  /** The filed facts the journal comparison compares, per line (`comparedTaxes`). */
  compared: D406FiledTax[][];
  /** The deductible amount and VAT period of each compared operation, as posted. */
  supplements: TaxSupplement[];
  /** Decisions the translation took that a reader of its differences should know. */
  notes: string[];
};

const cashVatOf = (reading: D406CodeReading) => 'cashVat' in reading && reading.cashVat === true;
const isRelease = (reading: D406CodeReading) => reading.source === 'cash-vat-release';
const isImport = (reading: D406CodeReading) => /^IMP-/.test(reading.code);
/** The VAT account an operation's side is booked on. */
const targetFamily = (direction: Direction, cashVat: boolean): Family =>
  cashVat ? '4428' : direction === 'input' ? '4426' : '4427';
/** A line's amount in a direction: debit-positive for input VAT, credit-positive for output. */
const signed = (line: TaxLine, direction: Direction) =>
  (line.side === 'D') === (direction === 'input') ? line.amount : negate(line.amount);

/** Whether two codes are the deductible and non-deductible reading of one acquisition, as
 * `readD406` pairs them: input readings in full and none, alike in everything else. */
function paired(deducted: string, kept: string, table: ReadingTable): boolean {
  const field = (reading: D406CodeReading, name: 'rate' | 'distance' | 'special' | 'cashVat') =>
    name in reading ? (reading as Record<string, unknown>)[name] : undefined;
  return table(deducted).some(
    (d) =>
      'direction' in d &&
      d.direction === 'input' &&
      'deduction' in d &&
      d.deduction === 'full' &&
      table(kept).some(
        (n) =>
          'direction' in n &&
          n.direction === 'input' &&
          'deduction' in n &&
          n.deduction === 'none' &&
          d.source === n.source &&
          d.code === n.code &&
          (['rate', 'cashVat', 'distance', 'special'] as const).every(
            (name) => (field(d, name) ?? false) === (field(n, name) ?? false),
          ),
      ),
  );
}

type Located = { line: number; index: number; tax: D406FiledTax; role: BlockRole };
type Read = { reading: D406CodeReading; direction: Direction; cashVat: boolean };
type SideRole = 'operation' | 'collected' | 'deferred' | 'marker';
type Side = { block: Located; read: Read; direction: Direction; role: SideRole; line?: number };

/**
 * Translates the TaxInformation of one filed transaction into `migration.journal` tax entries,
 * each pointing at the 4426, 4427 or 4428 line it books:
 * - an operation's code is read with `d406CodeReadings`; a code with several readings is kept
 *   only where the line's VAT account or the transaction's VAT accounts leave exactly one;
 * - an operation books the VAT line of its direction (4428 under VAT on collection), the line
 *   SAGA marks with its code first; a reverse charge or another acquisition whose collected side
 *   D406 reports with it also books the 4427 line of that side; a cash-VAT release (3801xx)
 *   books its 4426 or 4427 line and takes the same amounts back from 4428, its direction the
 *   line's, or the transaction's when exactly one of 4426 and 4427 is present;
 * - a marker on a VAT line no operation of the transaction claims books that line alone, with a
 *   zero base and amount (the operation it marks is reported elsewhere); an import's marker off
 *   the VAT accounts books the transaction's one uncoded VAT line of its direction, if exactly
 *   one exists; any other marker off the VAT accounts posts nothing;
 * - on a VAT closing note (380200) the 4426 and 4427 lines carry a settlement of the
 *   transaction's month instead;
 * - deductible (30xxxx) and non-deductible (35xxxx) operations of one acquisition, which
 *   `readD406` counts once, are refused unless their bases split their lines; a non-deductible
 *   operation books no unmarked VAT line;
 * - an entry is the only one on its line books the line's amount; several on one line book their
 *   own amounts; input VAT deducts what it books, output VAT nothing; a 4428 entry is not yet
 *   exigible, and keeps its operation's VAT period, a marker's none.
 * A line left without entries is left to the engine, which refuses it.
 */
export function translateTaxes(input: {
  transaction: D406FiledTransaction;
  lines: TaxLine[];
  /** The tax point: the document's date. */
  taxPoint: LocalDate;
  /** The transaction's month, YYYY-MM: the VAT period of its entries. */
  period: string;
  partyId?: string;
  readings?: ReadingTable;
}): TaxTranslation | TaxRefusal {
  const table = input.readings ?? d406CodeReadings;
  const lines = input.lines;
  const notes: string[] = [];
  const blocks: Located[] = input.transaction.lines.flatMap((line, l) =>
    (line.tax ?? []).map((tax, index) => ({ line: l, index, tax, role: blockRole(tax) })),
  );
  const compared = comparedTaxes(
    input.transaction,
    lines.map((line) => line.account),
    table,
  );
  const families = new Map(lines.map((line, l) => [l, familyOf(line.account)]));
  const closing = blocks.some((block) => block.role === 'closing');
  const settlements = new Map<number, { tax: string; period: string }>();
  const vat = blocks.filter((block) => block.role === 'marker' || block.role === 'operation');
  // A VAT closing note settles its 4426 and 4427 lines that carry no operation of their own.
  if (closing)
    for (const [l, family] of families)
      if (
        (family === '4426' || family === '4427') &&
        !vat.some((block) => block.line === l && block.role === 'operation')
      )
        settlements.set(l, { tax: 'VAT', period: input.period });
  const presentFamilies = new Set(
    [...families].filter(([l, f]) => f && !settlements.has(l)).map(([, f]) => f!),
  );
  /** A reading's direction; a release takes its line's, or the transaction's single one. */
  const directionOf = (reading: D406CodeReading, family: Family | null): Direction | null => {
    if ('direction' in reading) return reading.direction;
    if (family === '4426') return 'input';
    if (family === '4427') return 'output';
    const input_ = presentFamilies.has('4426');
    const output = presentFamilies.has('4427');
    return input_ === output ? null : input_ ? 'input' : 'output';
  };

  // Where each VAT block takes effect: its own VAT line, or for an import's marker off the VAT
  // accounts, the one VAT line of its direction that carries no code.
  const coded = new Set(vat.map((block) => block.line));
  const effective = new Map<Located, number>();
  const reads = new Map<Located, Read>();
  for (const block of vat) {
    if (block.tax.type !== '300') continue;
    if (settlements.has(block.line)) continue;
    let family = families.get(block.line) ?? null;
    let line = block.line;
    if (block.role === 'marker' && !family) {
      const readings = table(block.tax.code ?? '');
      const reading = readings.length === 1 ? readings[0]! : undefined;
      if (!reading || !isImport(reading) || !('direction' in reading)) continue;
      const target = targetFamily(reading.direction, cashVatOf(reading));
      const uncoded = [...families].filter(
        ([l, f]) => f === target && !coded.has(l) && !settlements.has(l),
      );
      if (uncoded.length !== 1) continue;
      line = uncoded[0]![0];
      family = target;
      coded.add(line);
      notes.push('IMPORT_MARKER_ATTACHED');
    }
    effective.set(block, line);
    const all = table(block.tax.code ?? '');
    if (!all.length)
      return { code: 'TAX_CODE_UNREAD', message: 'Codul de taxă nu are o citire în motor.' };
    let candidates = all;
    if (all.length > 1) {
      const fits = (reading: D406CodeReading) => {
        const direction = directionOf(reading, family);
        if (!direction) return false;
        const target = isRelease(reading) ? family : targetFamily(direction, cashVatOf(reading));
        return family ? target === family : presentFamilies.has(target!);
      };
      candidates = all.filter(fits);
    }
    if (candidates.length !== 1)
      return {
        code: 'TAX_CODE_AMBIGUOUS',
        message: 'Codul de taxă are mai multe citiri pe care contul liniei nu le deosebește.',
      };
    const reading = candidates[0]!;
    const direction = directionOf(reading, family);
    if (!direction)
      return {
        code: 'TAX_DIRECTION_UNKNOWN',
        message: 'Direcția eliberării TVA la încasare nu reiese din conturile notei.',
      };
    reads.set(block, { reading, direction, cashVat: !isRelease(reading) && cashVatOf(reading) });
  }

  const operations = vat.filter((block) => block.role === 'operation' && reads.has(block));
  // A deductible (30xxxx) and a non-deductible (35xxxx) operation of one acquisition: on one
  // line they split it when their bases add up to the line and neither is the whole line; on two
  // lines when each base is its own line. Otherwise `readD406` decides from the rate's VAT, which
  // the driver does not compute: the transaction is refused rather than counted twice.
  for (const deducted of operations) {
    if (!/^30\d{4}$/.test(deducted.tax.code ?? '')) continue;
    for (const kept of operations) {
      if (!/^35\d{4}$/.test(kept.tax.code ?? '')) continue;
      if (!paired(deducted.tax.code!, kept.tax.code!, table)) continue;
      const own = (block: Located) => money(lines[block.line]!.amount);
      const [a, b] = [money(deducted.tax.base), money(kept.tax.base)];
      const split =
        a !== null &&
        b !== null &&
        (deducted.line === kept.line
          ? add(a, b) === add(own(deducted)!, '0') && (a !== own(deducted) || b !== own(kept))
          : a === own(deducted) && b === own(kept));
      if (!split)
        return {
          code: 'TAX_PAIR_UNDECIDED',
          message: 'Blocurile deductibil și nedeductibil repetă aceeași achiziție.',
        };
    }
  }

  const sides: Side[] = [];
  const sideFamily = (side: Side): Family =>
    side.role === 'collected'
      ? '4427'
      : side.role === 'deferred'
        ? '4428'
        : targetFamily(side.direction, side.read.cashVat);
  for (const block of operations) {
    const read = reads.get(block)!;
    sides.push({ block, read, direction: read.direction, role: 'operation' });
    if (read.direction === 'input' && d406CollectedWithAcquisition(read.reading.code))
      sides.push({ block, read, direction: 'output', role: 'collected' });
    if (isRelease(read.reading))
      sides.push({ block, read, direction: read.direction, role: 'deferred' });
  }

  // Lines an operation's block sits on, and lines marked with an operation's code.
  const claimed = new Map<number, Located[]>();
  for (const [block, l] of effective)
    if (reads.has(block) && families.get(l)) claimed.set(l, [...(claimed.get(l) ?? []), block]);
  const markedFor = new Map<number, string>();
  for (const [l, located] of claimed) {
    const own = located.filter((block) => block.role === 'operation');
    const markers = located.filter((block) => block.role === 'marker');
    if (own.length) {
      if (markers.length)
        return { code: 'TAX_LINE_MARKERS', message: 'Linia de TVA are și operațiune, și marcaj.' };
      for (const block of own) {
        const mine = sides.filter((item) => item.block === block);
        const side =
          mine.find((item) => sideFamily(item) === families.get(l)) ??
          mine.find((item) => item.role === 'operation')!;
        side.line = l;
      }
      continue;
    }
    const codes = new Set(markers.map((block) => block.tax.code));
    if (codes.size > 1)
      return { code: 'TAX_LINE_MARKERS', message: 'Linia de TVA are marcaje cu coduri diferite.' };
    const code = [...codes][0]!;
    if (operations.some((block) => block.tax.code === code)) markedFor.set(l, code);
    else {
      if (markers.length > 1)
        return { code: 'TAX_LINE_MARKERS', message: 'Linia de TVA are mai multe marcaje.' };
      const block = markers[0]!;
      const read = reads.get(block)!;
      sides.push({ block, read, direction: read.direction, role: 'marker', line: l });
    }
  }

  const amountOf = (side: Side) => {
    const value = money(side.block.tax.amount);
    return value !== null && side.role === 'deferred' ? negate(value) : value;
  };
  const match = (pending: Side[], available: number[]): TaxRefusal | null => {
    if (!pending.length || !available.length) return null;
    if (available.length === 1) {
      for (const side of pending) side.line = available[0];
      return null;
    }
    if (pending.length !== available.length)
      return {
        code: 'TAX_LINE_AMBIGUOUS',
        message: 'Liniile de TVA nu se pot atribui operațiunilor.',
      };
    const free = [...pending];
    for (const l of available) {
      const index = free.findIndex(
        (side) =>
          amountOf(side) !== null && amountOf(side) === money(signed(lines[l]!, side.direction)),
      );
      if (index < 0)
        return {
          code: 'TAX_LINE_AMBIGUOUS',
          message: 'Liniile de TVA nu se pot atribui operațiunilor.',
        };
      free.splice(index, 1)[0]!.line = l;
    }
    return null;
  };
  const open = (side: Side) => side.line === undefined && side.role !== 'marker';
  // First the lines SAGA marks with an operation's code, then the unmarked lines of each account.
  for (const code of new Set(markedFor.values()))
    for (const family of ['4426', '4427', '4428'] as const) {
      const available = [...markedFor]
        .filter(([l, c]) => c === code && families.get(l) === family)
        .map(([l]) => l);
      const refusal = match(
        sides.filter((s) => open(s) && s.block.tax.code === code && sideFamily(s) === family),
        available,
      );
      if (refusal) return refusal;
    }
  // A non-deductible operation's VAT is no deduction: it books only a line marked with its code.
  const deducts = (side: Side) =>
    !('deduction' in side.read.reading) || side.read.reading.deduction !== 'none';
  for (const family of ['4426', '4427', '4428'] as const) {
    const available = [...families]
      .filter(([l, f]) => f === family && !claimed.has(l) && !settlements.has(l))
      .map(([l]) => l);
    const refusal = match(
      sides.filter((s) => open(s) && sideFamily(s) === family && deducts(s)),
      available,
    );
    if (refusal) return refusal;
  }

  const perLine = new Map<number, number>();
  for (const side of sides)
    if (side.line !== undefined) perLine.set(side.line, (perLine.get(side.line) ?? 0) + 1);
  const entries: TaxEntry[] = [];
  const supplements: TaxSupplement[] = [];
  for (const side of sides) {
    const { block, read } = side;
    const carrying = lines[block.line]!;
    // An operation without a base reads its line's amount as `readD406` reads invoice lines;
    // on a VAT line that amount is the VAT itself, so the base stays unknown and is refused.
    if (side.role !== 'marker' && block.tax.base === undefined && familyOf(carrying.account))
      return {
        code: 'TAX_BASE_MISSING',
        message: 'Operațiunea de pe o linie de TVA nu are baza taxei.',
      };
    const filedAmount = money(block.tax.amount);
    const filedBase =
      side.role === 'marker'
        ? '0.00'
        : block.tax.base !== undefined
          ? money(block.tax.base)
          : money(carrying.amount);
    if (filedAmount === null || filedBase === null)
      return { code: 'TAX_AMOUNT_FORMAT', message: 'Suma sau baza taxei nu are două zecimale.' };
    // A release's deferred side takes back from 4428 what its released side books.
    const [base, amount] =
      side.role === 'deferred'
        ? [negate(filedBase), negate(filedAmount)]
        : [filedBase, filedAmount];
    let booked = '0.00';
    if (side.line !== undefined) {
      const lineAmount = money(signed(lines[side.line]!, side.direction));
      if (lineAmount === null)
        return { code: 'TAX_AMOUNT_FORMAT', message: 'Suma liniei nu are două zecimale.' };
      booked = perLine.get(side.line) === 1 ? lineAmount : amount;
    }
    const pending =
      (side.line !== undefined && familyOf(lines[side.line]!.account) === '4428') ||
      (side.line === undefined && (read.cashVat || side.role === 'deferred'));
    const entry: TaxEntry = {
      key: `vat-${block.line}-${block.index}${side.role === 'collected' || side.role === 'deferred' ? `-${side.role}` : ''}`,
      tax: 'VAT',
      code: read.reading.code,
      direction: side.direction,
      base,
      amount,
      deductible: side.direction === 'input' ? booked : '0.00',
      taxPoint: input.taxPoint,
      exigibility: pending ? null : input.taxPoint,
      // A marker repeats an operation reported elsewhere and has no period of its own.
      taxPeriod: pending && side.role === 'marker' ? null : input.period,
      booked,
      ...(side.line !== undefined ? { line: side.line } : {}),
      ...(input.partyId ? { partyId: input.partyId } : {}),
      attributes: {
        saftTaxType: block.tax.type ?? '',
        saftTaxCode: block.tax.code ?? '',
        role: side.role,
        sourceLine: String(block.line),
        sourceBlock: String(block.index),
        ...(effective.get(block) !== block.line
          ? { attachedLine: String(effective.get(block)) }
          : {}),
      },
    };
    entries.push(entry);
    if (side.role === 'operation')
      supplements.push({
        filed: { line: block.line, tax: compared[block.line]!.indexOf(block.tax) },
        deductible: entry.deductible,
        period: entry.taxPeriod,
      });
  }
  return { settlements, entries, compared, supplements, notes };
}
