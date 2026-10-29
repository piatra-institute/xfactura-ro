import { element, serializeXml } from '../../xml/write';

/**
 * The recapitulative statement of intra-Community supplies and acquisitions (D390 VIES), from
 * ANAF's structure "D390 XML 2020" (namespace v3, XSD d390_12022021.xsd). Filed for each month
 * with such operations; its bases are whole lei.
 */
export const d390Namespace = 'mfp:anaf:dgti:d390:declaratie:v3';

/** Operation types: L intra-Community supplies of goods, T triangular supplies, A acquisitions
 * of goods, P services supplied, S services acquired, R supplies under the farmers' scheme. */
export const d390Types = ['L', 'T', 'A', 'P', 'S', 'R'] as const;
export type D390Type = (typeof d390Types)[number];

/** Member state codes of the structure's country list (Greece EL, Northern Ireland XI). */
export const d390Countries = [
  'AT',
  'BE',
  'BG',
  'CZ',
  'CY',
  'DK',
  'EE',
  'DE',
  'EL',
  'FI',
  'FR',
  'IE',
  'IT',
  'LV',
  'LU',
  'LT',
  'MT',
  'XI',
  'NL',
  'PL',
  'PT',
  'SI',
  'SK',
  'ES',
  'SE',
  'HU',
  'HR',
] as const;

export type D390Operation = {
  type: D390Type;
  country: (typeof d390Countries)[number];
  /** codO: the partner's VAT code without the country prefix; may be absent only for A and S. */
  code?: string;
  /** denO */
  name: string;
  /** baza, whole lei. */
  base: number;
};

export type D390 = {
  period: { year: number; month: number };
  /** d_rec: a rectifying statement. */
  rectification: boolean;
  declarant: { lastName: string; firstName: string; role: string };
  company: {
    cui: string;
    name: string;
    address: string;
    phone?: string;
    fax?: string;
    email?: string;
  };
  operations: D390Operation[];
};

export type D390Check = { code: string; path: string; message: string };

/** The structure accepts only these characters in text fields: letters without diacritics,
 * digits, space and + - . @ */
export function d390Text(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 +\-.@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function checkD390(model: D390): D390Check[] {
  const checks: D390Check[] = [];
  if (!model.operations.length)
    checks.push({
      code: 'D390_EMPTY',
      path: 'operations',
      message: 'Declarația D390 se depune doar pentru lunile cu operațiuni intracomunitare.',
    });
  const seen = new Set<string>();
  const names = new Map<string, string>();
  model.operations.forEach((operation, index) => {
    const path = `operations.${index}`;
    if (!operation.code && !['A', 'S'].includes(operation.type))
      checks.push({
        code: 'D390_CODE',
        path,
        message: 'Codul de TVA al partenerului este obligatoriu pentru livrări și prestări.',
      });
    const key = [
      operation.country,
      operation.code ?? '',
      d390Text(operation.name),
      operation.type,
    ].join('|');
    if (seen.has(key))
      checks.push({
        code: 'D390_DUPLICATE',
        path,
        message: 'Partenerul apare de mai multe ori pentru același tip de operațiune.',
      });
    seen.add(key);
    if (operation.code) {
      const partner = `${operation.country}|${operation.code}`;
      const name = d390Text(operation.name);
      if (names.has(partner) && names.get(partner) !== name && operation.type !== 'A')
        checks.push({
          code: 'D390_NAMES',
          path,
          message: 'Același partener apare cu denumiri diferite.',
        });
      names.set(partner, name);
    }
    if (model.rectification ? operation.base < 0 : operation.base === 0)
      checks.push({ code: 'D390_BASE', path, message: 'Baza impozabilă lipsește.' });
  });
  return checks;
}

/** The summary and control sum the statement computes from its operations. */
export function calculateD390(model: D390) {
  const bases = Object.fromEntries(d390Types.map((type) => [type, 0n])) as Record<D390Type, bigint>;
  for (const operation of model.operations) bases[operation.type] += BigInt(operation.base);
  const total = Object.values(bases).reduce((sum, value) => sum + value, 0n);
  const count = BigInt(model.operations.length);
  return { bases, total, count, control: count + total };
}

export function writeD390(model: D390): string {
  const { bases, total, count, control } = calculateD390(model);
  const text = (value: string | undefined) => (value === undefined ? undefined : d390Text(value));
  return serializeXml(
    element(
      'declaratie390',
      {
        xmlns: d390Namespace,
        luna: String(model.period.month),
        an: String(model.period.year),
        d_rec: model.rectification ? '1' : '0',
        nume_declar: text(model.declarant.lastName),
        prenume_declar: text(model.declarant.firstName),
        functie_declar: text(model.declarant.role),
        cui: model.company.cui,
        den: text(model.company.name),
        adresa: text(model.company.address),
        telefon: text(model.company.phone),
        fax: text(model.company.fax),
        mail: model.company.email,
        totalPlata_A: String(control),
      },
      element('rezumat', {
        nr_pag: '0',
        nrOPI: String(count),
        bazaL: String(bases.L),
        bazaT: String(bases.T),
        bazaA: String(bases.A),
        bazaP: String(bases.P),
        bazaS: String(bases.S),
        bazaR: String(bases.R),
        total_baza: String(total),
      }),
      model.operations.map((operation) =>
        element('operatie', {
          tip: operation.type,
          tara: operation.country,
          codO: operation.code,
          denO: d390Text(operation.name),
          baza: String(operation.base),
        }),
      ),
    ),
  );
}
