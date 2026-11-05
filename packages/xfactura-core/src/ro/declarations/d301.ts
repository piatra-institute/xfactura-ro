import { element, serializeXml } from '../../xml/write';
import { isValidCui } from '../identifiers';

/**
 * The special VAT return (D301, "decont special de taxă pe valoarea adăugată") of OPANAF nr.
 * 592/2016, after ANAF's XML structure D301_A2.0.0 (from 01.01.2016; schema d301_20200130.xsd,
 * namespace v1) and validator J1.2.5. A person not registered for VAT under art. 316 files it for
 * each month in which the VAT it owes becomes chargeable (Codul fiscal art. 324 alin. (1)–(2)): the
 * services bought from suppliers not established in Romania under the general rule (art. 307 alin.
 * (2)) in section 4, repeated in section 4.1 when the supplier is established in the EU; the
 * intra-Community acquisitions of goods (sections 1–3) are not produced.
 *
 * Amounts are lei with two decimals (N(15.2)); the control sum `totalPlata_A` is the integer part of
 * the sum of the ten totals. ANAF's validator checks the totals of each section, the control sum,
 * nr_evid and that every section 4.1 line repeats one of section 4; it does not check a line's base
 * against its currency value and rate, nor its VAT against the rate.
 */
export const d301Namespace = 'mfp:anaf:dgti:d301:declaratie:v1';

/** tip_operatie: 1 intra-Community acquisitions of goods, 2 new means of transport, 3 excise
 * goods, 4 art. 307 alin. (2), (3), (5) and (6), 5 the intra-Community services of section 4. */
export const d301Sections = [1, 2, 3, 4, 5] as const;
export type D301Section = (typeof d301Sections)[number];

/** The currencies of the structure's list (Str_tip_valutaSType). */
export const d301Currencies = [
  'EUR',
  'USD',
  'AUD',
  'CAD',
  'CHF',
  'CZK',
  'DKK',
  'EGP',
  'GBP',
  'HUF',
  'JPY',
  'MDL',
  'NOK',
  'PLN',
  'RON',
  'SEK',
  'TRY',
  'XDR',
  'BGN',
  'HRK',
] as const;

export type D301Line = {
  section: D301Section;
  /** nr_doc: the supplier's invoice number (or the self-invoice's), at most 20 characters. */
  number: string;
  /** data_doc, YYYY-MM-DD; written DD.MM.YYYY. */
  date: string;
  /** val_valuta: the value in the document's currency, as the document writes it (two decimals
   * at most). */
  currencyValue: string;
  currency: string;
  /** curs_valutar: the BNR rate at the chargeability date, four decimals ("1" for RON). */
  rate: string;
  /** baza, in bani. */
  baseBani: bigint;
  /** tva, in bani. */
  vatBani: bigint;
};

export type D301 = {
  period: { year: number; month: number };
  /** d_rec */
  rectification: boolean;
  /** temei: 0 none; 1 or 2, art. 105 alin. (6) lit. a) or b) of the procedure code. */
  afterReserveCancellation: 0 | 1 | 2;
  company: {
    /** cif: the CUI (the art. 317 code without RO), digits only. */
    cif: string;
    name: string;
    address?: string;
    phone?: string;
    fax?: string;
    email?: string;
    bank: string;
    account: string;
  };
  /** pers_inreg: 2 registered under art. 317, 1 not registered for VAT at all. */
  registeredArt317: boolean;
  declarant: { lastName: string; firstName: string; role: string };
  lines: D301Line[];
};

export type D301Check = { code: string; path: string; message: string };

const pad = (value: number) => String(value).padStart(2, '0');
const decimals = (bani: bigint) => {
  const negative = bani < 0n;
  const abs = negative ? -bani : bani;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};
const docDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/**
 * nr_evid (structure field 16): "10", 301, "01", the period's month and year (LLAA), the payment
 * due date (ZZLLAA, the 25th of the next month, art. 324 alin. (2)), "0" or "1" for new means of
 * transport, "000", and the sum of the 21 digits before it, two digits.
 */
export function d301PaymentNumber(period: D301['period'], transport = false): string {
  const [dueYear, dueMonth] =
    period.month === 12 ? [period.year + 1, 1] : [period.year, period.month + 1];
  const body = `1030101${pad(period.month)}${pad(period.year % 100)}25${pad(dueMonth)}${pad(dueYear % 100)}${transport ? '1' : '0'}000`;
  const sum = [...body].reduce((total, digit) => total + Number(digit), 0);
  return `${body}${pad(sum % 100)}`;
}

/** The totals of each section, the VAT payable (sections 1–4: 4.1 repeats lines of 4) and the
 * control sum. */
export function calculateD301(model: D301) {
  const base = Object.fromEntries(d301Sections.map((section) => [section, 0n])) as Record<
    D301Section,
    bigint
  >;
  const vat = { ...base };
  for (const line of model.lines) {
    base[line.section] += line.baseBani;
    vat[line.section] += line.vatBani;
  }
  const all = d301Sections.reduce((sum, section) => sum + base[section] + vat[section], 0n);
  return {
    base,
    vat,
    payable: vat[1] + vat[2] + vat[3] + vat[4],
    // INT(baza1 + … + tva5): the integer part, the sum being of amounts in lei.
    control: all >= 0n ? all / 100n : -((-all + 99n) / 100n),
    paymentNumber: d301PaymentNumber(model.period),
  };
}

const lineKey = (line: D301Line) =>
  [
    line.number,
    line.date,
    line.currencyValue,
    line.currency,
    line.rate,
    line.baseBani,
    line.vatBani,
  ]
    .map(String)
    .join('|');

/** The structure's and the validator's rules, as the writer can check them. */
export function checkD301(model: D301): D301Check[] {
  const checks: D301Check[] = [];
  const check = (code: string, path: string, message: string) =>
    checks.push({ code, path, message });
  if (model.period.year < 2016 || model.period.month < 1 || model.period.month > 12)
    check('D301_PERIOD', 'period', 'Structura D301_A2.0.0 se aplică perioadelor din 2016.');
  if (!isValidCui(model.company.cif) || /^RO/i.test(model.company.cif))
    check('D301_CIF', 'company.cif', 'Codul de identificare fiscală (CUI, fără RO) nu este valid.');
  for (const [field, value] of [
    ['bank', model.company.bank],
    ['account', model.company.account],
  ] as const)
    if (!value.trim() || /[,#]/.test(value) || value.length > 50)
      check(
        'D301_BANK',
        `company.${field}`,
        'Banca și contul se completează, fără virgulă sau #, cu cel mult 50 de caractere.',
      );
  if (!model.rectification && model.afterReserveCancellation === 1)
    check(
      'D301_TEMEI',
      'afterReserveCancellation',
      'Declarația inițială nu se depune în temeiul art. 105 alin. (6) lit. a).',
    );
  if (!model.lines.length)
    check(
      'D301_EMPTY',
      'lines',
      'Decontul special se depune doar pentru lunile în care ia naștere exigibilitatea taxei.',
    );
  const section4 = new Map<string, number>();
  model.lines.forEach((line, index) => {
    const path = `lines.${index}`;
    if (line.section !== 4 && line.section !== 5)
      check(
        'D301_SECTION',
        path,
        'Secțiunile 1–3 (achiziții intracomunitare de bunuri) nu sunt produse de motor.',
      );
    if (!line.number.trim() || line.number.length > 20)
      check('D301_DOCUMENT', path, 'Numărul documentului are cel mult 20 de caractere.');
    if (!(d301Currencies as readonly string[]).includes(line.currency))
      check('D301_CURRENCY', path, `Moneda ${line.currency} nu este în lista structurii.`);
    if (!/^\d{1,15}(\.\d{1,4})?$/.test(line.rate) || Number(line.rate) <= 0)
      check('D301_RATE', path, 'Cursul de schimb are cel mult patru zecimale.');
    if (!/^\d{1,15}(\.\d{1,2})?$/.test(line.currencyValue))
      check('D301_VALUE', path, 'Valoarea în valută are cel mult două zecimale și nu e negativă.');
    if (line.baseBani < 0n || line.vatBani < 0n)
      check(
        'D301_AMOUNT',
        path,
        'Structura nu admite valori negative: o regularizare se declară prin decont rectificativ.',
      );
    if (line.section === 4) section4.set(lineKey(line), (section4.get(lineKey(line)) ?? 0) + 1);
  });
  // R32: every line of section 4.1 is one of section 4.
  model.lines.forEach((line, index) => {
    if (line.section !== 5) return;
    const left = section4.get(lineKey(line)) ?? 0;
    if (!left)
      check(
        'D301_SECTION_41',
        `lines.${index}`,
        'Achiziția din secțiunea 4.1 nu se regăsește în secțiunea 4.',
      );
    else section4.set(lineKey(line), left - 1);
  });
  return checks;
}

/** The `declaratie301` element: attributes in the structure's order, one `sectiune` per line. */
export function writeD301(model: D301): string {
  const calculation = calculateD301(model);
  const totals: Record<string, string> = {};
  for (const section of d301Sections) {
    totals[`baza${section}`] = decimals(calculation.base[section]);
    totals[`tva${section}`] = decimals(calculation.vat[section]);
  }
  return serializeXml(
    element(
      'declaratie301',
      {
        xmlns: d301Namespace,
        luna: String(model.period.month),
        an: String(model.period.year),
        d_rec: model.rectification ? '1' : '0',
        mijl_trans: '0',
        temei: String(model.afterReserveCancellation),
        cif: model.company.cif.replace(/^RO/i, ''),
        denumire: model.company.name,
        adresa: model.company.address,
        telefon: model.company.phone,
        fax: model.company.fax,
        email: model.company.email,
        banca: model.company.bank,
        cont: model.company.account,
        pers_inreg: model.registeredArt317 ? '2' : '1',
        nr_evid: calculation.paymentNumber,
        ...totals,
        totalPlata_A: calculation.control.toString(),
        nume_declarant: model.declarant.lastName,
        prenume_declarant: model.declarant.firstName,
        functia_declarant: model.declarant.role,
      },
      model.lines.map((line) =>
        element('sectiune', {
          tip_operatie: String(line.section),
          nr_doc: line.number,
          data_doc: docDate(line.date),
          val_valuta: line.currencyValue,
          tip_valuta: line.currency,
          curs_valutar: line.rate,
          baza: decimals(line.baseBani),
          tva: decimals(line.vatBani),
        }),
      ),
    ),
  );
}
