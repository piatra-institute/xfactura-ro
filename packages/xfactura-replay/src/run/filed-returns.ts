import { readDeclaration, type FiledDeclaration } from 'xfactura-core/ro/declarations/read';
import { d394RefundFlags } from 'xfactura-core/ro/declarations/d394';
import { s1005F20Rows, s1005F30Rows, s1005F40Rows } from 'xfactura-core/ro/annual/s1005';
import { s1005Formulas } from 'xfactura-core/ro/annual/s1005-accounts';
import { d406AccountId, d406AmbiguousAccounts } from 'xfactura-core/ro/saft/accounts';
import type { D406Filed } from 'xfactura-core/ro/saft/read';
import { order } from '../compare/differences';
import type { CompanyReturnPayload } from '../mapping/corpus';

/** The returns the return replay rebuilds. */
export const returnForms = ['D300', 'D394', 'D406', 'S1005'] as const;
export type ReturnForm = (typeof returnForms)[number];
export type DeclarationForm = Exclude<ReturnForm, 'D406'>;

export class FiledReturnError extends Error {
  constructor(readonly code: string) {
    super(`${code}: Declarația depusă nu poate fi citită.`);
  }
}

/** A filed D300, D394 or S1005 as the return replay reads it. */
export type FiledReturn = {
  form: DeclarationForm;
  /** The engine's period (`YYYY-MM`, `YYYY-Qn`, `YYYY`), null for a kind the engine does not
   * prepare (a half-yearly or annual VAT return). */
  period: string | null;
  /** The return's own period kind: L, T, S or A for D300 and D394, A for S1005. */
  type: string;
  /** The filed period's months, `YYYY-MM`. */
  months: { from: string; to: string };
  declaration: FiledDeclaration;
  xml: Uint8Array;
  sha256: string;
};

const pad = (value: number) => String(value).padStart(2, '0');

/** An attribute of the document element. */
export function rootAttribute(declaration: FiledDeclaration, name: string): string | undefined {
  return declaration.fields.find((field) => field.path === `${declaration.root}/@${name}`)?.value;
}

/** The attributes of each occurrence of a child element of the document element. */
export function childElements(
  declaration: FiledDeclaration,
  name: string,
): Record<string, string>[] {
  const elements = new Map<string, Record<string, string>>();
  const prefix = new RegExp(`^${declaration.root}/(${name}(?:\\[\\d+\\])?)/@([^/]+)$`);
  for (const field of declaration.fields) {
    const match = prefix.exec(field.path);
    if (!match) continue;
    const element = elements.get(match[1]!) ?? {};
    element[match[2]!] = field.value;
    elements.set(match[1]!, element);
  }
  return [...elements.values()];
}

/** The engine period of a VAT return of type L (a month) or T (a quarter), from its last month. */
function vatReturnPeriod(year: string, month: number, type: string) {
  if (type === 'L') return `${year}-${pad(month)}`;
  if (type === 'T' && month % 3 === 0) return `${year}-Q${month / 3}`;
  return null;
}

/** The months of an engine period: a month, a quarter or a year. */
export function periodMonths(period: string): { from: string; to: string } {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) {
    const last = Number(quarter[2]) * 3;
    return { from: `${quarter[1]}-${pad(last - 2)}`, to: `${quarter[1]}-${pad(last)}` };
  }
  if (/^\d{4}$/.test(period)) return { from: `${period}-01`, to: `${period}-12` };
  return { from: period, to: period };
}

/** The last day of a month, `YYYY-MM-DD`. */
export function monthEnd(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return `${month}-${pad(new Date(Date.UTC(year, number, 0)).getUTCDate())}`;
}

/** Months as the difference store dates them: one month, or their first and last days. */
export function storePeriod(months: { from: string; to: string }): string {
  return months.from === months.to ? months.from : `${months.from}-01/${monthEnd(months.to)}`;
}

/**
 * Reads each payload as its form's return and checks that it is the company's. A D300 or D394
 * names its period by its last month and its type; an S1005 by its year.
 */
export function readFiledReturns(
  payloads: readonly CompanyReturnPayload[],
  company: string,
): FiledReturn[] {
  const returns: FiledReturn[] = [];
  for (const payload of payloads) {
    let declaration: FiledDeclaration;
    try {
      declaration = readDeclaration(payload.xml);
    } catch {
      throw new FiledReturnError('FILED_RETURN_UNREADABLE');
    }
    if (declaration.form !== payload.form) throw new FiledReturnError('FILED_RETURN_FORM');
    if ((declaration.fiscalCode ?? '').replace(/\s+/g, '').replace(/^RO/i, '') !== company)
      throw new FiledReturnError('FILED_RETURN_COMPANY');
    const year = declaration.period?.year ?? '';
    const month = Number(declaration.period?.month ?? '');
    if (!/^\d{4}$/.test(year)) throw new FiledReturnError('FILED_RETURN_PERIOD');
    if (payload.form === 'S1005') {
      returns.push({
        form: 'S1005',
        period: year,
        type: 'A',
        months: { from: `${year}-01`, to: `${year}-12` },
        declaration,
        xml: payload.xml,
        sha256: payload.sha256,
      });
      continue;
    }
    if (payload.form !== 'D300' && payload.form !== 'D394')
      throw new FiledReturnError('FILED_RETURN_FORM');
    if (!Number.isInteger(month) || month < 1 || month > 12)
      throw new FiledReturnError('FILED_RETURN_PERIOD');
    const type = rootAttribute(declaration, payload.form === 'D300' ? 'tip_decont' : 'tip_D394');
    if (!type) throw new FiledReturnError('FILED_RETURN_PERIOD');
    const span = type === 'T' ? 3 : type === 'S' ? 6 : type === 'A' ? 12 : 1;
    returns.push({
      form: payload.form,
      period: vatReturnPeriod(year, month, type),
      type,
      months: {
        from: `${year}-${pad(Math.max(1, month - span + 1))}`,
        to: `${year}-${pad(month)}`,
      },
      declaration,
      xml: payload.xml,
      sha256: payload.sha256,
    });
  }
  return returns;
}

/** A filed return the selection keeps, or the reason it keeps none for that form and period. */
export type SelectedReturn = {
  form: DeclarationForm;
  /** The engine period, or `<last month>/<type>` for a kind the engine does not prepare. */
  period: string;
  months: { from: string; to: string };
  collapsed: string[];
} & ({ filed: FiledReturn } | { blocked: 'FILED_REFILINGS_AMBIGUOUS' | 'FILED_PERIOD_KIND' });

/**
 * One filed return per form and period inside the replayed months. Identical payloads were
 * collapsed when read; of re-filings that differ, the one rectifying return is the latest, and
 * without exactly one the choice is the owner's (`FILED_REFILINGS_AMBIGUOUS`). A half-yearly or
 * annual VAT return names a period the engine does not prepare (`FILED_PERIOD_KIND`).
 */
export function selectReturns(
  filed: readonly FiledReturn[],
  forms: readonly ReturnForm[],
  replayed: { from: string; to: string },
): { selected: SelectedReturn[]; outsideReplay: number } {
  const groups = new Map<string, FiledReturn[]>();
  let outsideReplay = 0;
  for (const item of filed) {
    if (!forms.includes(item.form)) continue;
    if (item.months.from < replayed.from || item.months.to > replayed.to) {
      outsideReplay++;
      continue;
    }
    const key = JSON.stringify([item.form, item.period ?? `${item.type}:${item.months.to}`]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const selected: SelectedReturn[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const period = first.period ?? `${first.months.to}/${first.type}`;
    const hashes = group.map((item) => item.sha256).sort(order);
    const base = { form: first.form, period, months: first.months };
    if (first.period === null) {
      selected.push({ ...base, blocked: 'FILED_PERIOD_KIND', collapsed: hashes });
      continue;
    }
    const rectifying = group.filter((item) => item.declaration.rectifying === true);
    const chosen = group.length === 1 ? first : rectifying.length === 1 ? rectifying[0] : undefined;
    if (!chosen)
      selected.push({ ...base, blocked: 'FILED_REFILINGS_AMBIGUOUS', collapsed: hashes });
    else
      selected.push({
        ...base,
        filed: chosen,
        collapsed: hashes.filter((hash) => hash !== chosen.sha256),
      });
  }
  const formOrder = (form: string) => returnForms.indexOf(form as ReturnForm);
  selected.sort((a, b) => order(a.months.to, b.months.to) || formOrder(a.form) - formOrder(b.form));
  return { selected, outsideReplay };
}

const present = (value: string | undefined) =>
  value !== undefined && value.trim() !== '' ? value.trim() : undefined;
/** Drops absent fields, so that the engine's own schema refuses what the filed return lacks. */
const compact = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
const integer = (value: string | undefined) =>
  value !== undefined && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
const flag = (value: string | undefined) =>
  value === '1' ? true : value === '0' ? false : undefined;

/**
 * The D300 options the filed return states: its declarant, CAEN class, bank and account,
 * contacts, pro-rata and refund choice, and the previous return's balances it carries (rd. 35 and
 * 38, `previous`), since the lab authorizes no return the next one could carry them from. A field
 * the filed return lacks stays absent.
 */
export function d300OptionsOf(filed: FiledDeclaration): Record<string, unknown> {
  const a = (name: string) => present(rootAttribute(filed, name));
  const refund = a('solicit_ramb');
  return compact({
    declarant: compact({
      lastName: a('nume_declar'),
      firstName: a('prenume_declar'),
      role: a('functie_declar'),
    }),
    caen: a('caen'),
    bank: a('banca'),
    account: a('cont'),
    phone: a('telefon'),
    email: a('mail'),
    proRata: a('pro_rata'),
    refundRequested: refund === 'D' ? true : refund === 'N' ? false : undefined,
    previous: { unpaid: integer(a('R35_2')) ?? 0, negative: integer(a('R38_2')) ?? 0 },
  });
}

/**
 * The D394 options the filed return states: identification, representative and preparer, the
 * consultation and affiliates flags, the invoice series issued outside the engine (serieFacturi
 * 1 and 2, nrFacturi, storno invoices) and the refund's nature when it requests one.
 */
export function d394OptionsOf(filed: FiledDeclaration): Record<string, unknown> {
  const a = (name: string) => present(rootAttribute(filed, name));
  const [information = {}] = childElements(filed, 'informatii');
  const series = childElements(filed, 'serieFacturi');
  const range = (item: Record<string, string>) =>
    compact({ series: present(item.serieI), first: present(item.nrI), last: present(item.nrF) });
  const allocated = series.filter((item) => item.tip === '1').map(range);
  const issued = series.filter((item) => item.tip === '2').map(range);
  const storno = childElements(filed, 'facturi')
    .filter((item) => item.tip_factura === '1')
    .map((item) => compact({ series: present(item.serie), number: present(item.nr) }));
  const invoices = integer(information.nrFacturi);
  const preparerKind = a('tip_intocmit');
  return compact({
    caen: a('caen'),
    phone: a('telefon'),
    email: a('mail'),
    representative: compact({
      cif: a('cifR'),
      name: a('denR'),
      role: a('functie_reprez'),
      address: a('adresaR'),
    }),
    preparer:
      preparerKind === '0'
        ? compact({
            kind: 'company',
            cui: a('cif_intocmit'),
            name: a('den_intocmit'),
            capacity: a('calitate_intocmit'),
          })
        : preparerKind === '1'
          ? compact({
              kind: 'individual',
              cnp: a('cif_intocmit'),
              name: a('den_intocmit'),
              capacity: a('calitate_intocmit'),
              position: a('functie_intocmit'),
            })
          : undefined,
    consultation: flag(a('optiune')),
    ...(a('schimb_optiune') ? { consultationChanged: flag(a('schimb_optiune')) } : {}),
    affiliates: flag(a('prsAfiliat')),
    outsideSeries:
      allocated.length || issued.length || (invoices ?? 0) > 0 || storno.length
        ? { allocated, issued, ...(invoices === undefined ? {} : { invoices }), storno }
        : undefined,
    refund:
      information.solicit === '1'
        ? Object.fromEntries(d394RefundFlags.map(([name]) => [name, information[name] === '1']))
        : undefined,
  });
}

/** `Sector:x,Localitate:y,Strada:z,Nr.:n,Bloc:b,Scara:s,Ap.:a,` as the form writes `adresa`. */
function annualAddress(text: string | undefined) {
  if (!text) return undefined;
  const parts = new Map<string, string>();
  for (const part of text.split(',')) {
    const at = part.indexOf(':');
    if (at > 0) parts.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const value = (label: string) => present(parts.get(label));
  const sector = integer(value('Sector'));
  return compact({
    sector,
    locality: value('Localitate'),
    street: value('Strada'),
    number: value('Nr.'),
    block: value('Bloc'),
    staircase: value('Scara'),
    apartment: value('Ap.'),
  });
}

const accountRows = new Set(s1005Formulas.map((formula) => `${formula.form}.${formula.row}`));

/**
 * The S1005 options the filed statement states: the entity's identification, administrator,
 * preparer and audit, the previous year's F20 and F30 account rows (its column 1, as the
 * statement restates the year the lab does not keep), F20 rd. 01a and chapter XIX's rows without
 * accounts, and F40 col. 4 (scrapped). Which row an account the form spreads over several rows
 * belongs to is not stated by the statement, so `rows` stays empty.
 */
export function s1005OptionsOf(filed: FiledDeclaration): Record<string, unknown> {
  const a = (name: string) => present(rootAttribute(filed, name));
  const cells = new Map<string, string>();
  for (const form of ['F20', 'F30', 'F40'])
    for (const [name, value] of Object.entries(childElements(filed, form)[0] ?? {}))
      cells.set(name, value);
  const cell = (form: string, code: string, column: number) =>
    integer(cells.get(`${form}_${code}${column}`));
  const previous = (form: 'F20' | 'F30', rows: readonly { row: string; code: string }[]) =>
    Object.fromEntries(
      rows.flatMap((spec) => {
        const value = accountRows.has(`${form}.${spec.row}`) ? cell(form, spec.code, 1) : undefined;
        return value === undefined ? [] : [[spec.row, value]];
      }),
    );
  const manual = (rows: readonly { row: string; code: string; columns: readonly number[] }[]) =>
    Object.fromEntries(
      rows.flatMap((spec) => {
        const values = spec.columns.map((column) => cell('F30', spec.code, column) ?? null);
        return values.some((value) => value !== null) ? [[spec.row, values]] : [];
      }),
    );
  const turnoverRow = s1005F20Rows.find((spec) => spec.row === '01a');
  const turnover = turnoverRow
    ? [cell('F20', turnoverRow.code, 1), cell('F20', turnoverRow.code, 2)]
    : [];
  // F40 col. 4 where the filed statement has reductions (col. 3) to split.
  const scrapped = Object.fromEntries(
    s1005F40Rows.flatMap((spec) => {
      const value = spec.columns.includes(4) ? cell('F40', spec.code, 4) : undefined;
      return value === undefined || !cell('F40', spec.code, 3) ? [] : [[spec.row, value]];
    }),
  );
  const audit = a('d_audit');
  const auditKind =
    audit === '1'
      ? 'statutory'
      : audit === '2'
        ? 'voluntary'
        : audit === '3'
          ? 'censors'
          : undefined;
  return compact({
    entity: compact({
      tradeRegister: a('regCom'),
      ownership: integer(a('codPP')),
      caen: a('caen'),
      caenActual: a('caenE'),
      caenVersion: integer(a('AN_CAEN')),
      lei: a('codLEI'),
      largeTaxpayer: flag(a('bifaMC')),
      branch: flag(a('bifaDD')),
      economicInterestGroup: flag(a('bifaGG')),
      netAssetsBelowHalfCapital: flag(a('bifaAA')),
      phone: a('telefon'),
      address: annualAddress(a('adresa')),
    }),
    administrator: a('nume_admin'),
    preparer: compact({
      name: a('nume_intocmit'),
      quality: integer(a('calit_intocmit')),
      membership: a('nri_intocmit'),
      cif: a('cif_intocmit'),
    }),
    audit: auditKind
      ? compact({
          kind: auditKind,
          auditor: a('den_audi')
            ? compact({ name: a('den_audi'), registration: a('nr_audi'), cif: a('cif_audi') })
            : undefined,
        })
      : undefined,
    internalAudit: a('d_audit_intern') === '1' ? true : undefined,
    approved: flag(a('bifa_aprob')),
    informative: compact({
      F20:
        turnoverRow && turnover.some((value) => value !== undefined)
          ? { [turnoverRow.row]: turnover.map((value) => value ?? null) }
          : undefined,
      F30: (() => {
        const rows = manual(
          s1005F30Rows.filter(
            (spec) => spec.chapter === 'XIX' && !accountRows.has(`F30.${spec.row}`),
          ),
        );
        return Object.keys(rows).length ? rows : undefined;
      })(),
    }),
    scrapped: Object.keys(scrapped).length ? scrapped : undefined,
    previous: {
      F20: previous('F20', s1005F20Rows),
      F30: previous('F30', s1005F30Rows),
    },
  });
}

/**
 * The D406 options the filed file states: its contact person; the standard account its accounts
 * name where ANAF subdivides a synthetic (605, 612, 623, 635, 646), when every account of that
 * synthetic names the same one; and, for an engine account whose code has no numeric form, the
 * AccountID the company numbers it by, when one filed account maps to it.
 */
export function d406OptionsOf(
  filed: D406Filed,
  engineAccount: (source: string) => string | undefined,
): Record<string, unknown> {
  const contact = filed.header.company.contact;
  const choices = new Map<string, Set<string>>();
  const ids = new Map<string, Set<string>>();
  for (const account of filed.masterFiles.accounts) {
    const standard = present(account.standard);
    const synthetic = standard?.slice(0, 3);
    if (standard && synthetic && d406AmbiguousAccounts[synthetic]?.includes(standard))
      choices.set(synthetic, (choices.get(synthetic) ?? new Set()).add(standard));
    const code = account.id ? engineAccount(account.id) : undefined;
    if (
      account.id &&
      code &&
      /^[1-7]\d{2,3}\.[\w.-]{1,40}$/.test(code) &&
      d406AccountId(code) === undefined &&
      /^[1-9]\d{2,69}$/.test(account.id) &&
      account.id.startsWith(code.split('.')[0]!)
    )
      ids.set(code, (ids.get(code) ?? new Set()).add(account.id));
  }
  const single = (map: Map<string, Set<string>>) =>
    Object.fromEntries(
      [...map]
        .filter(([, values]) => values.size === 1)
        .map(([key, values]) => [key, [...values][0]!]),
    );
  const accounts = single(choices);
  const accountIds = single(ids);
  return compact({
    contact: contact
      ? compact({
          firstName: present(contact.firstName),
          lastName: present(contact.lastName),
          phone: present(contact.phone),
          email: present(contact.email),
        })
      : undefined,
    accounts: Object.keys(accounts).length ? accounts : undefined,
    accountIds: Object.keys(accountIds).length ? accountIds : undefined,
  });
}
