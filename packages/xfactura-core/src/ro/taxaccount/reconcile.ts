import { formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import type { StatementObligation, TaxStatementDocument } from './documents';
import { taxTypeLabels, taxTypes, type ObligationCatalogue } from './obligations';

/*
 * The close check of the tax account: ANAF's statement of the taxpayer's account (fișa pe
 * plătitor, situația sintetică) against what the books hold for the same authority on the same
 * day, per obligation and period. Every difference comes with what explains it, as far as the
 * books can tell: a rounding to the leu, accessories ANAF computed that no decision booked yet, an
 * obligation booked but not declared (or declared and not booked), a payment ANAF distributed
 * otherwise, a payment not yet distributed.
 */

export interface BookItem {
  openItem: string;
  account: string;
  period: string | null;
  /** In bani: positive owed by the company, negative owed to it. */
  balance: bigint;
}

/** What the books hold for one obligation, kind and period on the statement's day. */
export interface BookPosition {
  obligation: StatementObligation;
  kind: 'principal' | 'accessory';
  period: string | null;
  items: BookItem[];
}

export type DifferenceCode =
  | 'ROUNDING'
  | 'ACCESSORIES_UNBOOKED'
  | 'NOT_IN_BOOKS'
  | 'NOT_ON_STATEMENT'
  | 'AMOUNT'
  | 'DISTRIBUTION'
  | 'UNDISTRIBUTED'
  | 'OUTSIDE_BOOKS';

export interface ReconciledRow {
  obligation: StatementObligation;
  label: string;
  kind: 'principal' | 'accessory';
  period: string | null;
  /** In lei, as decimal strings: positive owed by the company. */
  statement: string;
  books: string;
  difference: string;
  matched: boolean;
  explanations: { code: DifferenceCode; message: string }[];
  items: { openItem: string; account: string; period: string | null; balance: string }[];
}

const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);
const labelOf = (obligation: StatementObligation) =>
  (taxTypes as readonly string[]).includes(obligation)
    ? taxTypeLabels[obligation as (typeof taxTypes)[number]]
    : {
        undistributed: 'Plăți nedistribuite / sume plătite în plus',
        vat_refund: 'TVA de rambursat',
        fine: 'Amenzi',
        other: 'Alte obligații',
      }[obligation as 'undistributed'];
/** The single account's types: a payment ANAF distributed otherwise moves amounts between them
 * and the undistributed sums, whose differences then add up to nothing. */
const singleKinds = (catalogue: ObligationCatalogue) =>
  new Set<string>([
    ...Object.values(catalogue.principal)
      .filter((entry) => entry.single)
      .map((entry) => entry.type),
    ...Object.values(catalogue.byTreatment).flatMap((split) =>
      Object.values(split)
        .filter((entry) => entry.single)
        .map((entry) => entry.type),
    ),
    'undistributed',
  ]);

/**
 * Each obligation, kind and period of the statement or of the books, compared. A statement row
 * without a period is compared with the books' total for that obligation and kind; a row with
 * one, with that period's. Within a leu (the statement's amounts are in whole lei) it matches.
 */
export function reconcileStatement(
  statement: TaxStatementDocument,
  books: readonly BookPosition[],
  catalogue: ObligationCatalogue,
): ReconciledRow[] {
  const keyOf = (obligation: string, kind: string, period: string | null) =>
    `${obligation}|${kind}|${period ?? ''}`;
  const stated = new Map<
    string,
    {
      obligation: StatementObligation;
      kind: 'principal' | 'accessory';
      period: string | null;
      bani: bigint;
      label: string;
    }
  >();
  for (const row of statement.rows) {
    const key = keyOf(row.obligation, row.kind, row.period);
    const known = stated.get(key);
    const bani = parseMoney(row.balance.replace(/^-/, ''), LEDGER_CURRENCY);
    stated.set(key, {
      obligation: row.obligation,
      kind: row.kind,
      period: row.period,
      bani: (known?.bani ?? 0n) + (row.balance.startsWith('-') ? -bani : bani),
      label: known?.label ?? row.label,
    });
  }
  // The books, by the statement's granularity: per period where the statement shows periods.
  const periodic = new Set(
    [...stated.values()]
      .filter((row) => row.period !== null)
      .map((row) => `${row.obligation}|${row.kind}`),
  );
  const held = new Map<
    string,
    {
      obligation: StatementObligation;
      kind: 'principal' | 'accessory';
      period: string | null;
      items: BookItem[];
    }
  >();
  for (const position of books) {
    const period = periodic.has(`${position.obligation}|${position.kind}`) ? position.period : null;
    const key = keyOf(position.obligation, position.kind, period);
    const known = held.get(key) ?? {
      obligation: position.obligation,
      kind: position.kind,
      period,
      items: [],
    };
    known.items.push(...position.items);
    held.set(key, known);
  }
  const keys = [...new Set([...stated.keys(), ...held.keys()])].sort();
  const rows = keys.map((key) => {
    const row = stated.get(key);
    const book = held.get(key);
    const obligation = (row ?? book)!.obligation;
    const kind = (row ?? book)!.kind;
    const period = (row ?? book)!.period;
    const statementBani = row?.bani ?? 0n;
    const booksBani = (book?.items ?? []).reduce((sum, item) => sum + item.balance, 0n);
    const difference = statementBani - booksBani;
    const explanations: ReconciledRow['explanations'] = [];
    const small = difference > -100n && difference < 100n;
    if (difference !== 0n && small)
      explanations.push({
        code: 'ROUNDING',
        message: `Diferență sub un leu (${lei(difference)} lei): fișa ține obligațiile rotunjite la leu, registrele în bani.`,
      });
    else if (difference !== 0n) {
      if (obligation === 'other' || obligation === 'fine')
        explanations.push({
          code: 'OUTSIDE_BOOKS',
          message:
            'Obligație pe care registrele nu o țin pe un cont al autorității: înregistrați decizia sau documentul care o stabilește.',
        });
      else if (kind === 'accessory' && difference > 0n)
        explanations.push({
          code: 'ACCESSORIES_UNBOOKED',
          message: `ANAF a calculat accesorii de ${lei(difference)} lei pe care nicio decizie înregistrată nu le cuprinde: înregistrați decizia referitoare la obligațiile de plată accesorii (tax.decision) când este comunicată.`,
        });
      else if (obligation === 'undistributed')
        explanations.push({
          code: 'UNDISTRIBUTED',
          message:
            difference < 0n
              ? 'Fișa arată plăți încă nedistribuite pe care registrele le-au distribuit deja: o obligație din registre nu este încă declarată sau scadentă la ANAF.'
              : 'Registrele țin plăți nedistribuite pe care ANAF le-a distribuit deja: distribuiți-le (tax.distribute) sau verificați obligațiile declarate.',
        });
      else if (!row)
        explanations.push({
          code: 'NOT_ON_STATEMENT',
          message: `Registrele datorează ${lei(booksBani)} lei pe care fișa nu îi arată: declarația nu este încă depusă sau procesată, ori plata a fost distribuită altfel.`,
        });
      else if (!book)
        explanations.push({
          code: 'NOT_IN_BOOKS',
          message: `Fișa arată ${lei(statementBani)} lei pe care registrele nu îi țin: o obligație declarată, o decizie sau o plată neînregistrată.`,
        });
      else
        explanations.push({
          code: 'AMOUNT',
          message: `Fișa arată ${lei(statementBani)} lei, registrele ${lei(booksBani)} lei.`,
        });
    }
    return {
      obligation,
      label: row?.label ?? labelOf(obligation),
      kind,
      period,
      statementBani,
      booksBani,
      difference,
      small,
      explanations,
      items: (book?.items ?? []).map((item) => ({
        openItem: item.openItem,
        account: item.account,
        period: item.period,
        balance: lei(item.balance),
      })),
    };
  });
  // A payment ANAF distributed otherwise moves amounts between the single account's types: their
  // differences then add up to less than a leu.
  const single = singleKinds(catalogue);
  const moved = rows.filter((row) => !row.small && single.has(row.obligation));
  const net = moved.reduce((sum, row) => sum + row.difference, 0n);
  if (moved.length > 1 && net > -100n * BigInt(moved.length) && net < 100n * BigInt(moved.length))
    for (const row of moved)
      row.explanations.push({
        code: 'DISTRIBUTION',
        message:
          'Diferențele obligațiilor plătite în contul unic se compensează între ele: ANAF a distribuit plata altfel decât registrele (de exemplu proporțional între bugete, sau o obligație nescadentă încă). Regularizați distribuirea după fișă.',
      });
  return rows.map(({ statementBani, booksBani, difference, small, ...row }) => ({
    ...row,
    statement: lei(statementBani),
    books: lei(booksBani),
    difference: lei(difference),
    matched: small,
  }));
}
