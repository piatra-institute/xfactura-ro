// Frozen copies of the invoicer's input preparation as it was before the TypeScript writer
// (xfactura-web logic/einvoice.ts, logic/utilities.ts, logic/validation.ts, data/constants.tsx),
// so the oracle keeps reproducing the previous output. Do not fix bugs here.

const countyMap: Record<string, string> = {
    'Alba': 'AB',
    'Arad': 'AR',
    'Arges': 'AG',
    'Bacău': 'BC',
    'Bihor': 'BH',
    'Bistrița-Năsăud': 'BN',
    'Botoșani': 'BT',
    'Brașov': 'BV',
    'Brăila': 'BR',
    'București': 'B',
    'Buzău': 'BZ',
    'Caraș-Severin': 'CS',
    'Cluj': 'CJ',
    'Constanţa': 'CT',
    'Covasna': 'CV',
    'Călărași': 'CL',
    'Dolj': 'DJ',
    'Dâmbovița': 'DB',
    'Galați': 'GL',
    'Giurgiu': 'GR',
    'Gorj': 'GJ',
    'Harghita': 'HR',
    'Hunedoara': 'HD',
    'Ialomiţa': 'IL',
    'Iași': 'IS',
    'Ilfov': 'IF',
    'Maramureș': 'MM',
    'Mehedinți': 'MH',
    'Mureș': 'MS',
    'Neamț': 'NT',
    'Olt': 'OT',
    'Prahova': 'PH',
    'Satu Mare': 'SM',
    'Sibiu': 'SB',
    'Suceava': 'SV',
    'Sălaj': 'SJ',
    'Teleorman': 'TR',
    'Timiș': 'TM',
    'Tulcea': 'TL',
    'Vaslui': 'VS',
    'Vrancea': 'VN',
    'Vâlcea': 'VL',
};

const countryMap: Record<string, string> = {
    'Romania': 'RO',
};

export const getDateFormat = (timestamp: number) => new Date(timestamp).toISOString().split('T')[0];

const normalizeDiacritics = (value: string) =>
  value
    ? value
        .replace(/ă/g, 'a')
        .replace(/â/g, 'a')
        .replace(/î/g, 'i')
        .replace(/ș/g, 's')
        .replace(/ş/g, 's')
        .replace(/ț/g, 't')
        .replace(/ţ/g, 't')
    : '';

const normalizeCountyString = (value: string) =>
  value
    ? normalizeDiacritics(
        value
          .trim()
          .toLowerCase()
          .replace(/ /g, '')
          .replace(/-/g, '')
          .replace(/mun\.?(icipiul?)?/i, ''),
      )
    : '';

const toNormalCase = (value: string) => {
  const chars = [...value];
  return chars
    .map((letter, index) =>
      index === 0 || chars[index - 1] === ' ' || chars[index - 1] === '-'
        ? letter.toUpperCase()
        : letter.toLowerCase(),
    )
    .join('')
    .trim();
};

export const normalizeUserCountry = (value: string) =>
  countryMap[normalizeDiacritics(toNormalCase(value))] || 'RO';

export const normalizeUserCounty = (userCounty: string, userCountry: string) => {
  const normalized = normalizeCountyString(userCounty);
  for (const [key, value] of Object.entries(countyMap))
    if (normalizeCountyString(key) === normalized) return normalizeUserCountry(userCountry) + '-' + value;
  return undefined;
};

export const normalizeUserCity = (userCity: string, userCounty: string) => {
  if (normalizeCountyString(userCounty) === 'bucuresti') {
    const match = userCity.trim().toLowerCase().match(/sector? (\d)/i);
    if (match) return 'SECTOR' + match[1];
  }
  return userCity;
};

export const normalizeVatNumber = (vatNumber: string | null | undefined, vatPayer: boolean | undefined) => {
  if (!vatNumber) return '';
  const value = vatNumber.toUpperCase().replace(/\s/g, '');
  if (value.startsWith('RO')) return value;
  return vatPayer ? 'RO' + value : value;
};
