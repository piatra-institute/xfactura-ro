/** Romanian counties by ISO 3166-2:RO subdivision code, which CIUS-RO requires in BT-39/BT-54. */
export const counties: Readonly<Record<string, string>> = {
  'RO-AB': 'Alba',
  'RO-AR': 'Arad',
  'RO-AG': 'Argeș',
  'RO-BC': 'Bacău',
  'RO-BH': 'Bihor',
  'RO-BN': 'Bistrița-Năsăud',
  'RO-BT': 'Botoșani',
  'RO-BR': 'Brăila',
  'RO-BV': 'Brașov',
  'RO-B': 'București',
  'RO-BZ': 'Buzău',
  'RO-CL': 'Călărași',
  'RO-CS': 'Caraș-Severin',
  'RO-CJ': 'Cluj',
  'RO-CT': 'Constanța',
  'RO-CV': 'Covasna',
  'RO-DB': 'Dâmbovița',
  'RO-DJ': 'Dolj',
  'RO-GL': 'Galați',
  'RO-GR': 'Giurgiu',
  'RO-GJ': 'Gorj',
  'RO-HR': 'Harghita',
  'RO-HD': 'Hunedoara',
  'RO-IL': 'Ialomița',
  'RO-IS': 'Iași',
  'RO-IF': 'Ilfov',
  'RO-MM': 'Maramureș',
  'RO-MH': 'Mehedinți',
  'RO-MS': 'Mureș',
  'RO-NT': 'Neamț',
  'RO-OT': 'Olt',
  'RO-PH': 'Prahova',
  'RO-SJ': 'Sălaj',
  'RO-SM': 'Satu Mare',
  'RO-SB': 'Sibiu',
  'RO-SV': 'Suceava',
  'RO-TR': 'Teleorman',
  'RO-TM': 'Timiș',
  'RO-TL': 'Tulcea',
  'RO-VL': 'Vâlcea',
  'RO-VS': 'Vaslui',
  'RO-VN': 'Vrancea',
};

/** Lower case, without diacritics (both cedilla and comma-below forms), spaces, dots or hyphens. */
export function foldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s.\-_]/g, '');
}

const countyByName = new Map(
  Object.entries(counties).map(([code, name]) => [foldName(name), code] as const),
);

/**
 * The subdivision code for a county as people write it: "Galaţi", "Neamț", "Arges",
 * "Municipiul București", "Mun. Bucuresti", "RO-GL" or "GL".
 */
export function countyCode(text: string): string | undefined {
  const trimmed = text.trim().toUpperCase();
  if (counties[trimmed]) return trimmed;
  if (counties[`RO-${trimmed}`]) return `RO-${trimmed}`;
  const folded = foldName(text).replace(/^(municipiul|municipiu|mun)/, '');
  return countyByName.get(folded);
}

/** "SECTOR1"–"SECTOR6", the CityName CIUS-RO requires for Bucharest, from "Sector 3",
 * "Sectorul 3", "sector3" or "Bucuresti Sectorul 3". */
export function bucharestSector(city: string): string | undefined {
  const match = /sector(?:ul)?(\d)$/.exec(
    foldName(city).replace(/^(municipiul|mun)?bucuresti/, ''),
  );
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 6 ? `SECTOR${match[1]}` : undefined;
}

/** ISO 3166-1 alpha-2 codes by Romanian and English names, for the countries the invoicer meets. */
const countryNames: Readonly<Record<string, readonly string[]>> = {
  RO: ['România', 'Romania'],
  AT: ['Austria'],
  BE: ['Belgia', 'Belgium'],
  BG: ['Bulgaria'],
  CY: ['Cipru', 'Cyprus'],
  CZ: ['Cehia', 'Republica Cehă', 'Czechia', 'Czech Republic'],
  DE: ['Germania', 'Germany'],
  DK: ['Danemarca', 'Denmark'],
  EE: ['Estonia'],
  GR: ['Grecia', 'Greece'],
  ES: ['Spania', 'Spain'],
  FI: ['Finlanda', 'Finland'],
  FR: ['Franța', 'France'],
  HR: ['Croația', 'Croatia'],
  HU: ['Ungaria', 'Hungary'],
  IE: ['Irlanda', 'Ireland'],
  IT: ['Italia', 'Italy'],
  LT: ['Lituania', 'Lithuania'],
  LU: ['Luxemburg', 'Luxembourg'],
  LV: ['Letonia', 'Latvia'],
  MT: ['Malta'],
  NL: ['Olanda', 'Țările de Jos', 'Netherlands'],
  PL: ['Polonia', 'Poland'],
  PT: ['Portugalia', 'Portugal'],
  SE: ['Suedia', 'Sweden'],
  SI: ['Slovenia'],
  SK: ['Slovacia', 'Slovakia'],
  GB: ['Regatul Unit', 'Marea Britanie', 'United Kingdom'],
  US: ['Statele Unite', 'Statele Unite ale Americii', 'SUA', 'United States'],
  CH: ['Elveția', 'Switzerland'],
  NO: ['Norvegia', 'Norway'],
  MD: ['Republica Moldova', 'Moldova'],
  UA: ['Ucraina', 'Ukraine'],
  TR: ['Turcia', 'Turkey'],
  RS: ['Serbia'],
  CN: ['China'],
};

const countryByName = new Map<string, string>();
for (const [code, names] of Object.entries(countryNames)) {
  countryByName.set(foldName(code), code);
  for (const name of names) countryByName.set(foldName(name), code);
}

/** The alpha-2 code for a country name or code, or undefined when unknown — never a default. */
export function countryCode(text: string): string | undefined {
  return countryByName.get(foldName(text));
}

/** EU member states, with the VAT identifier prefix where it differs from the ISO code. */
export const euVatPrefixes: Readonly<Record<string, string>> = Object.fromEntries(
  ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT']
    .concat(['LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'])
    .map((code) => [code, code])
    .concat([['GR', 'EL']]),
);
