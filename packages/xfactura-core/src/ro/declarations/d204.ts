import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';

/**
 * The Declarație anuală de venit pentru asocieri fără personalitate juridică (formular 204) of an
 * association whose members are individuals with independent income in the real system: a family
 * enterprise (întreprindere familială) among them. It declares the association's gross income,
 * deductible expenses and net income or loss, and their distribution to the members by quota
 * (Codul fiscal art. 125 alin. (4)–(5)); each member then declares their share in their own D212
 * (art. 122 alin. (4)).
 *
 * The form is OPANAF nr. 470/2021's, replaced by OPANAF nr. 90/2022 for the income from 2022; the
 * XML is ANAF's structure "declaratie:v3" for an >= 2018 (structura_D204_2025_150126.pdf, SHA-256
 * 1aa53edc…), checked by ANAF's validator J3.0.14 (D204_16012026.zip, 5679dd85…). That validator
 * loads in both DUKIntegrator kits. It checks the identification codes, the lists, the dates and
 * the loss rows (R46), but it does not require the quotas to add up to 100%, it only warns about a
 * member's share more than 1 leu away from the quota, and it does not tie the net income to the
 * gross income less the expenses: checkD204 is the gate for those.
 *
 * Written: categ_venit 1 (activități independente), forma_org 1 (asociere fără personalitate
 * juridică), det_ven_net 1 (sistem real), no annex. Not written: other categories, entities under
 * fiscal transparency, and norms: an association whose members are taxed on norms files no D204
 * (art. 125 alin. (1) lit. c), alin. (10); OPANAF nr. 470/2021 anexa nr. 2 pct. 2), and the
 * structure allows det_ven_net 2 only for agriculture. The CNPs are written into the XML and
 * nowhere else.
 */

export type D204Format = {
  /** The income year (`an`). */
  year: number;
  namespace: string;
  structure: string;
  validator: string;
};

const namespace = 'mfp:anaf:dgti:d204:declaratie:v3';
/** The structure is ANAF's for an >= 2018 and the form OPANAF nr. 90/2022's for the income from
 * 2022: pinned for the income years from 2022 to 2026. */
const years = [2022, 2023, 2024, 2025, 2026];

export function d204Format(year: number): D204Format | null {
  return years.includes(year)
    ? {
        year,
        namespace,
        structure: 'D204 declaratie:v3, structura 15.01.2026',
        validator: 'D204Validator J3.0.14',
      }
    : null;
}

/** The structure's county codes ("Nomenclator ordonatori - Județe"), by ISO 3166-2:RO code
 * without its prefix. */
export const d204Counties: Readonly<Record<string, string>> = {
  AB: '1',
  AR: '2',
  AG: '3',
  BC: '4',
  BH: '5',
  BN: '6',
  BT: '7',
  BV: '8',
  BR: '9',
  BZ: '10',
  CS: '11',
  CJ: '12',
  CT: '13',
  CV: '14',
  DB: '15',
  DJ: '16',
  GL: '17',
  GJ: '18',
  HR: '19',
  HD: '20',
  IL: '21',
  IS: '22',
  IF: '23',
  MM: '24',
  MH: '25',
  MS: '26',
  NT: '27',
  OT: '28',
  PH: '29',
  SM: '30',
  SJ: '31',
  SB: '32',
  SV: '33',
  TR: '34',
  TM: '35',
  TL: '36',
  VS: '37',
  VL: '38',
  VN: '39',
  B: '40',
  CL: '51',
  GR: '52',
};

export type D204Member = {
  /** nume_d: last and first name. */
  name: string;
  /** cif_d */
  cnp: string;
  /** dom_d */
  domicile?: string;
  /** cota_d, in hundredths of a percent (6000 = 60%). */
  quotaBp: number;
  /** venit_d, pierd_d: the net income and the loss distributed to the member, in lei. */
  net: number;
  loss: number;
};

export type D204 = {
  /** The income year. */
  year: number;
  rectifies?: boolean;
  /** Section I: the association. */
  association: { name: string; cif: string; address: string; phone?: string; email?: string };
  /** Section IV: the associate who answers for its obligations (art. 125 alin. (2) lit. e)). */
  representative: { name: string; cnp: string; address: string; phone?: string; email?: string };
  /** Sections II and III. Dates are YYYY-MM-DD. */
  activity: {
    caen: string;
    /** ISO 3166-2:RO county code, without its prefix (GL, B). */
    county: string;
    locality?: string;
    /** Bucharest's sector, 1–6. */
    sector?: number;
    /** sediu: street, number, building. */
    seat: string;
    /** nr_contr, data_contr: the association contract as registered with the fiscal body. */
    contract: { number: string; date: string };
    /** nr_doc, data_doc: the authorization. */
    authorization?: { number: string; date: string };
    /** data_I, data_F: only when the activity started or ended in the year. */
    startedOn?: string;
    endedOn?: string;
    /** venit3, chelt3, net3, pierd3: the fiscal register's totals, in lei. */
    gross: number;
    deductible: number;
    net: number;
    loss: number;
  };
  /** Section V. */
  members: D204Member[];
};

export type D204Check = {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const maxAmount = 999_999_999_999_999;
const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maxAmount;
const formDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
function isDate(date: string | undefined): date is string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!match) return false;
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return value.toISOString().slice(0, 10) === date;
}
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
/** cota_d: up to three integer digits and two decimals, without trailing zeros. */
export const quotaText = (bp: number) =>
  bp % 100 === 0
    ? String(bp / 100)
    : `${Math.trunc(bp / 100)}.${String(bp % 100)
        .padStart(2, '0')
        .replace(/0$/, '')}`;
const blank = (value: string | undefined) => value?.trim() || undefined;

/**
 * The structure's controls and the rules ANAF's validator leaves out, in Romanian: the
 * identification codes, the county and sector, the contract and the dates, the totals (net income
 * and loss from the gross income and the expenses), the quotas adding up to 100%, and each
 * member's share within 1 leu of the quota (the structure's ERR, the validator's warning). The
 * shares not adding up to the total is a warning: the structure rounds each one.
 */
export function checkD204(model: D204): D204Check[] {
  const checks: D204Check[] = [];
  const error = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'error', path, message });
  const warning = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'warning', path, message });
  const yearEnd = `${model.year}-12-31`;
  if (!d204Format(model.year))
    error(
      'D204_YEAR',
      'year',
      `Declarația 204 pentru veniturile anului ${model.year} nu are o structură fixată (${years[0]}–${years.at(-1)}).`,
    );
  const text = (path: string, value: string | undefined, max: number, label: string) => {
    if (!value?.trim()) error('D204_TEXT', path, `Completați ${label}.`);
    else if (value.trim().length > max)
      error('D204_TEXT', path, `${label} are cel mult ${max} de caractere.`);
  };
  const contact = (path: string, item: { phone?: string; email?: string }) => {
    if (item.phone !== undefined && !/^\+?[\d\s.\-()]{1,15}$/.test(item.phone.trim()))
      error('D204_TEXT', `${path}.phone`, 'Telefonul are cel mult 15 caractere.');
    if (item.email !== undefined && (!isEmail(item.email) || item.email.length > 200))
      warning('D204_EMAIL', `${path}.email`, 'E-mailul nu este valid.');
  };

  // Sections I and IV.
  const { association, representative, activity } = model;
  text('association.name', association.name, 75, 'denumirea asocierii');
  if (!isValidCui(association.cif) || /^RO/i.test(association.cif.trim()))
    error(
      'D204_CIF',
      'association.cif',
      'Codul de identificare fiscală al asocierii nu este valid.',
    );
  text('association.address', association.address, 200, 'adresa asocierii');
  contact('association', association);
  text('representative.name', representative.name, 75, 'numele responsabilului asocierii');
  if (!isValidCnp(representative.cnp))
    error('D204_CNP', 'representative.cnp', 'CNP-ul responsabilului asocierii nu este valid.');
  else if (!model.members.some((member) => member.cnp === representative.cnp))
    error(
      'D204_REPRESENTATIVE',
      'representative',
      'Responsabilul asocierii este unul dintre asociați (asociatul desemnat).',
    );
  text('representative.address', representative.address, 200, 'adresa responsabilului');
  contact('representative', representative);

  // Section II.
  if (!/^\d{4}$/.test(activity.caen))
    error('D204_CAEN', 'activity.caen', 'Codul CAEN are patru cifre.');
  if (!d204Counties[activity.county])
    error('D204_COUNTY', 'activity.county', 'Județul nu este în nomenclatorul structurii.');
  const bucharest = activity.county === 'B';
  if (bucharest !== (activity.sector !== undefined))
    error(
      'D204_SECTOR',
      'activity.sector',
      'Sectorul se completează numai și obligatoriu pentru Municipiul București.',
    );
  else if (activity.sector !== undefined && ![1, 2, 3, 4, 5, 6].includes(activity.sector))
    error('D204_SECTOR', 'activity.sector', 'Sectorul este între 1 și 6.');
  if (activity.locality !== undefined)
    text('activity.locality', activity.locality, 50, 'localitatea');
  text('activity.seat', activity.seat, 200, 'sediul');
  text(
    'activity.contract.number',
    activity.contract?.number,
    15,
    'numărul contractului de asociere',
  );
  if (!isDate(activity.contract?.date) || activity.contract.date > yearEnd)
    error(
      'D204_CONTRACT',
      'activity.contract.date',
      `Data contractului de asociere este o dată de până la ${formDate(yearEnd)}.`,
    );
  if (activity.authorization) {
    text(
      'activity.authorization.number',
      activity.authorization.number,
      15,
      'numărul documentului de autorizare',
    );
    if (!isDate(activity.authorization.date) || activity.authorization.date > yearEnd)
      error(
        'D204_DATE',
        'activity.authorization.date',
        `Data documentului de autorizare este o dată de până la ${formDate(yearEnd)}.`,
      );
  }
  for (const key of ['startedOn', 'endedOn'] as const) {
    const value = activity[key];
    if (value !== undefined && (!isDate(value) || !value.startsWith(`${model.year}-`)))
      error(
        'D204_DATE',
        `activity.${key}`,
        `Data începerii sau a încetării activității se completează numai pentru evenimente din ${model.year}.`,
      );
  }
  if (activity.startedOn && activity.endedOn && activity.startedOn >= activity.endedOn)
    error('D204_DATE', 'activity.endedOn', 'Activitatea încetează după ziua în care începe.');

  // Section III: the register's totals.
  const amounts = {
    gross: activity.gross,
    deductible: activity.deductible,
    net: activity.net,
    loss: activity.loss,
  };
  const bad = Object.entries(amounts).filter(([, value]) => !isAmount(value));
  for (const [key] of bad)
    error(
      'D204_AMOUNT',
      `activity.${key}`,
      'Sumele se declară în lei, fără zecimale, nenegative, de cel mult 15 cifre.',
    );
  if (!bad.length) {
    const net = Math.max(activity.gross - activity.deductible, 0);
    const loss = Math.max(activity.deductible - activity.gross, 0);
    if (activity.net !== net || activity.loss !== loss)
      error(
        'D204_TOTALS',
        'activity.net',
        `Venitul net este ${net} lei și pierderea ${loss} lei: venitul brut minus cheltuielile deductibile.`,
      );
  }

  // Section V: the members, their quotas and shares.
  if (!model.members.length)
    error('D204_MEMBERS', 'members', 'Declarația cuprinde cel puțin un asociat.');
  const cnps = new Set<string>();
  let quotas = 0;
  model.members.forEach((member, index) => {
    const path = `members.${index}`;
    text(`${path}.name`, member.name, 75, 'numele asociatului');
    // The CNP is never repeated in a message.
    if (!isValidCnp(member.cnp))
      error('D204_CNP', `${path}.cnp`, 'CNP-ul asociatului nu este valid.');
    else if (cnps.has(member.cnp))
      error('D204_MEMBERS', `${path}.cnp`, 'Un asociat apare de mai multe ori.');
    cnps.add(member.cnp);
    if (member.domicile !== undefined)
      text(`${path}.domicile`, member.domicile, 200, 'domiciliul asociatului');
    if (!Number.isInteger(member.quotaBp) || member.quotaBp <= 0 || member.quotaBp > 10_000)
      error('D204_QUOTA', `${path}.quotaBp`, 'Cota asociatului este între 0,01% și 100%.');
    quotas += member.quotaBp;
    for (const key of ['net', 'loss'] as const) {
      if (!isAmount(member[key])) {
        error('D204_AMOUNT', `${path}.${key}`, 'Sumele distribuite sunt în lei, fără zecimale.');
        continue;
      }
      if (bad.length) continue;
      // round(total × cota) with a margin of 1 leu (the structure's rows 53–54).
      const rounded = Math.round((activity[key] * member.quotaBp) / 10_000);
      if (Math.abs(member[key] - rounded) > 1)
        error(
          'D204_DISTRIBUTION',
          `${path}.${key}`,
          `${key === 'net' ? 'Venitul net distribuit' : 'Pierderea distribuită'} asociatului ${index + 1} (${member[key]} lei) nu corespunde cotei de ${quotaText(member.quotaBp)}% din ${activity[key]} lei.`,
        );
    }
  });
  if (model.members.length && quotas !== 10_000)
    error(
      'D204_QUOTA',
      'members',
      `Cotele asociaților se însumează la ${quotaText(quotas)}%, nu la 100% (art. 125 alin. (5)).`,
    );
  if (!bad.length && model.members.every((member) => isAmount(member.net) && isAmount(member.loss)))
    for (const key of ['net', 'loss'] as const) {
      const sum = model.members.reduce((total, member) => total + member[key], 0);
      if (sum !== activity[key])
        warning(
          'D204_DISTRIBUTION',
          'members',
          `${key === 'net' ? 'Veniturile nete distribuite' : 'Pierderile distribuite'} însumează ${sum} lei, iar asocierea are ${activity[key]} lei.`,
        );
    }
  return checks;
}

/** The declaration's XML; throws where checkD204 finds an error. */
export function writeD204(model: D204): string {
  const [problem] = checkD204(model).filter((check) => check.severity === 'error');
  if (problem) throw new DomainError(problem.code, problem.message);
  const { association, representative, activity } = model;
  return serializeXml(
    element(
      'd204',
      {
        xmlns: namespace,
        luna: '12',
        an: String(model.year),
        d_rec: model.rectifies ? '1' : '0',
        totalPlata_A: '0',
        nume: association.name.trim(),
        cif: association.cif.trim(),
        adresa: association.address.trim(),
        telefon: blank(association.phone),
        email: blank(association.email),
        den_r: representative.name.trim(),
        cif_r: representative.cnp,
        adresa_r: representative.address.trim(),
        telefon_r: blank(representative.phone),
        email_r: blank(representative.email),
      },
      element(
        'activitate',
        {
          categ_venit: '1',
          forma_org: '1',
          det_ven_net: '1',
          nr_asoc: String(model.members.length),
          CAEN: activity.caen,
          judet: d204Counties[activity.county],
          localitate: blank(activity.locality),
          sector: activity.sector?.toString(),
          sediu: activity.seat.trim(),
          nr_contr: activity.contract.number.trim(),
          data_contr: formDate(activity.contract.date),
          nr_doc: activity.authorization && activity.authorization.number.trim(),
          data_doc: activity.authorization && formDate(activity.authorization.date),
          data_I: activity.startedOn && formDate(activity.startedOn),
          data_F: activity.endedOn && formDate(activity.endedOn),
          venit3: String(activity.gross),
          chelt3: String(activity.deductible),
          net3: String(activity.net),
          pierd3: String(activity.loss),
        },
        model.members.map((member) =>
          element('asociat', {
            nume_d: member.name.trim(),
            cif_d: member.cnp,
            dom_d: blank(member.domicile),
            cota_d: quotaText(member.quotaBp),
            venit_d: String(member.net),
            pierd_d: String(member.loss),
          }),
        ),
      ),
    ),
  );
}
