import { divRound } from '../../money';
import { element, serializeXml } from '../../xml/write';
import { isValidCui } from '../identifiers';

/**
 * The special VAT return (form 398, „Declarație specială de TVA (VAT Return)”) of the Union
 * scheme (Codul fiscal art. 315 alin. (6)–(12)), after ANAF's XML structure A1.0.10 of 04.09.2024
 * (schema d398_20211101.xsd, namespace v1) and validator J1.0.11 of 29.04.2025. Only the Union
 * scheme (`moes_voes_imp` 1) without electronic interfaces (`e_int` 0) and from Romania (trade
 * type 1) is written: the non-Union scheme is not a Romanian company's (art. 314 alin. (1) lit.
 * a)), the import scheme is not covered, and goods dispatched from other Member States or
 * services from fixed establishments abroad (trade type 2) are not built.
 *
 * Amounts are euro with two decimals. Per Member State of consumption (never RO, ANAF's R15):
 * one SUPPLY per supply type, rate type and rate, its taxable amount and VAT (> 0); the state's
 * totals for services and goods from Romania; `grand_total` their sum; `due_balance` the grand
 * total plus the corrections declared for the state. CORRECTION lines change earlier quarters'
 * VAT per state, within three years (alin. (11)), positive or negative. `grand_total_vat_due` sums
 * the positive balances and the positive corrections of states without supplies in the quarter.
 * ANAF's structure admits no rectifying return (`d_rec` is only 0). `totalPlata_A` is the scheme
 * plus the nil flag.
 */
export const d398Namespace = 'mfp:anaf:dgti:d398:declaratie:v1';

/** The states of LISTA_STATE_MS a Romanian company declares (RO excluded; XI is goods only). */
export const d398States = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'EL',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'SK',
  'SI',
  'ES',
  'SE',
] as const;

export type D398Supply = {
  state: string;
  type: 'goods' | 'services';
  rateType: 'standard' | 'reduced';
  /** The Member State's rate, e.g. '19', '5.5'. */
  rate: string;
  /** Euro cents. */
  taxableCents: bigint;
  vatCents: bigint;
};

export type D398Correction = {
  state: string;
  /** The corrected quarter: its year and last month (3, 6, 9, 12). */
  year: number;
  month: number;
  /** Euro cents, signed. */
  vatCents: bigint;
};

export type D398 = {
  /** The quarter: its year and last month. */
  period: { year: number; month: number };
  /** The company's VAT code (its CUI; written with RO, as ANAF's R10 reads it). */
  vatId: string;
  name: string;
  supplies: readonly D398Supply[];
  corrections: readonly D398Correction[];
};

export type D398Check = { code: string; path: string; message: string };

const cents = (value: bigint) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

/** The totals per state, the due balances, the grand total and the control sum. */
export function calculateD398(model: D398) {
  const states = [...new Set(model.supplies.map((item) => item.state))].sort(
    (a, b) => d398States.indexOf(a as never) - d398States.indexOf(b as never),
  );
  const perState = states.map((state) => {
    const supplies = model.supplies.filter((item) => item.state === state);
    const services = supplies
      .filter((item) => item.type === 'services')
      .reduce((sum, item) => sum + item.vatCents, 0n);
    const goods = supplies
      .filter((item) => item.type === 'goods')
      .reduce((sum, item) => sum + item.vatCents, 0n);
    const corrections = model.corrections
      .filter((item) => item.state === state)
      .reduce((sum, item) => sum + item.vatCents, 0n);
    return {
      state,
      supplies,
      services,
      goods,
      total: services + goods,
      balance: services + goods + corrections,
    };
  });
  const elsewhere = model.corrections.filter((item) => !states.includes(item.state));
  const due =
    perState.reduce((sum, item) => sum + (item.balance > 0n ? item.balance : 0n), 0n) +
    elsewhere.reduce((sum, item) => sum + (item.vatCents > 0n ? item.vatCents : 0n), 0n);
  const nil = !model.supplies.length && !model.corrections.length;
  return { perState, due, nil, control: 1 + (nil ? 1 : 0) };
}

/** The VAT of a taxable amount at a rate, in cents, half up (ANAF's R29 reference). */
export const d398Vat = (taxableCents: bigint, rate: string) =>
  divRound(taxableCents * BigInt(Math.round(Number(rate) * 100)), 10_000n, 'halfAwayFromZero');

/** The structure's checks the writer repeats, so a return ANAF's validator refuses is not written. */
export function checkD398(model: D398): D398Check[] {
  const checks: D398Check[] = [];
  const add = (code: string, path: string, message: string) => checks.push({ code, path, message });
  if (model.period.year < 2021 || ![3, 6, 9, 12].includes(model.period.month))
    add('D398_PERIOD', 'period', 'Regimul Uniune se declară pe trimestre (luna 3, 6, 9 sau 12).');
  if (!isValidCui(model.vatId.replace(/^RO/i, '')))
    add('D398_VAT_ID', 'vatId', `Codul ${model.vatId} nu este un cod de înregistrare valid.`);
  if (!model.name.trim() || model.name.length > 100)
    add('D398_NAME', 'name', 'Denumirea are 1–100 de caractere.');
  const seen = new Set<string>();
  model.supplies.forEach((item, index) => {
    const at = `supplies.${index}`;
    if (!(d398States as readonly string[]).includes(item.state))
      add('D398_STATE', at, `${item.state} nu este un stat membru de consum al regimului Uniune.`);
    const key = `${item.state}|${item.type}|${item.rateType}|${Number(item.rate)}`;
    if (seen.has(key)) add('D398_SUPPLY_UNIQUE', at, `Operațiunile ${key} apar de două ori.`);
    seen.add(key);
    if (item.taxableCents <= 0n || item.vatCents <= 0n)
      add(
        'D398_SUPPLY_POSITIVE',
        at,
        `Valoarea impozabilă și TVA din ${item.state} la ${item.rate}% sunt pozitive (${cents(item.taxableCents)}, ${cents(item.vatCents)} €); o reducere a unui trimestru anterior este o corecție.`,
      );
    // R29.1, as validator J1.0.11 applies it: from the whole euros of taxable × rate ÷ 100 to
    // one euro above (a sum of invoices' VAT just under a whole euro is refused).
    const floor = (item.taxableCents * BigInt(Math.round(Number(item.rate) * 100))) / 1_000_000n;
    if (item.vatCents < floor * 100n || item.vatCents > floor * 100n + 100n)
      add(
        'D398_VAT',
        at,
        `TVA ${cents(item.vatCents)} € din ${item.state} la ${item.rate}% este în afara limitelor admise de ANAF pentru ${cents(item.taxableCents)} € (${floor}–${floor + 1n} €, regula R29.1; calculat ${cents(d398Vat(item.taxableCents, item.rate))} €).`,
      );
  });
  const corrected = new Set<string>();
  model.corrections.forEach((item, index) => {
    const at = `corrections.${index}`;
    const key = `${item.state}|${item.year}|${item.month}`;
    if (corrected.has(key)) add('D398_CORRECTION_UNIQUE', at, `Corecția ${key} apare de două ori.`);
    corrected.add(key);
    if (!(d398States as readonly string[]).includes(item.state))
      add('D398_STATE', at, `${item.state} nu este un stat membru de consum al regimului Uniune.`);
    if (item.vatCents === 0n) add('D398_CORRECTION_ZERO', at, 'O corecție nu este zero.');
    if (![3, 6, 9, 12].includes(item.month) || item.year < 2021)
      add(
        'D398_CORRECTION_PERIOD',
        at,
        'Corecția privește un trimestru (luna 3, 6, 9, 12) din 2021.',
      );
    const months = (model.period.year - item.year) * 12 + model.period.month - item.month;
    if (months <= 0)
      add('D398_CORRECTION_PERIOD', at, 'Corecția privește un trimestru anterior celui declarat.');
  });
  return checks;
}

/** The XML of the return, as ANAF's structure orders it. */
export function writeD398(model: D398): string {
  const calculation = calculateD398(model);
  const typeCode = (type: D398Supply['type']) => (type === 'goods' ? '1' : '2');
  return serializeXml(
    element(
      'd398',
      {
        xmlns: d398Namespace,
        an_r: String(model.period.year),
        luna_r: String(model.period.month),
        d_rec: '0',
        moes_voes_imp: '1',
        e_int: '0',
        nil_vat_return: calculation.nil ? '1' : '0',
        currency: 'EUR',
        // ANAF's R10 takes the CUI with its RO prefix for the Union scheme.
        vat_id_no: `RO${model.vatId.replace(/^RO/i, '')}`,
        name: model.name,
        grand_total_vat_due: cents(calculation.due),
        totalPlata_A: String(calculation.control),
      },
      [
        ...calculation.perState.map((state) =>
          element(
            'MS',
            {
              mscon_state: state.state,
              grand_total: cents(state.total),
              vat_total_services_msid: cents(state.services),
              vat_total_goods_msid: cents(state.goods),
              vat_total_services_msest: '0.00',
              vat_total_goods_msest: '0.00',
              due_balance: cents(state.balance),
            },
            [...state.supplies]
              .sort(
                (a, b) =>
                  typeCode(a.type).localeCompare(typeCode(b.type)) ||
                  a.rateType.localeCompare(b.rateType) ||
                  Number(b.rate) - Number(a.rate),
              )
              .map((item) =>
                element('SUPPLY', {
                  // From Romania (trade type 1): no fixed establishment's code (R24.4).
                  trade_type: '1',
                  supply_type: typeCode(item.type),
                  vat_rate_type: item.rateType === 'standard' ? '1' : '2',
                  vat_rate: String(Number(item.rate)),
                  taxable_amount: cents(item.taxableCents),
                  vat_amount: cents(item.vatCents),
                }),
              ),
          ),
        ),
        ...[...model.corrections]
          .sort((a, b) => a.year - b.year || a.month - b.month || a.state.localeCompare(b.state))
          .map((item) =>
            element('CORRECTION', {
              mscon_state_correction: item.state,
              vat_return_correction_period: String(item.month),
              year: String(item.year),
              vat_amount_correction: cents(item.vatCents),
            }),
          ),
      ],
    ),
  );
}
