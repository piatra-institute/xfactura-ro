// Invented microentities' ledgers and statements for 2025, shared by the S1005 unit tests and the
// official validation (scripts/validators/official-s1005.test.ts).
import {
  s1005Columns,
  s1005FromLedger,
  type S1005LedgerEntry,
} from '../../src/ro/annual/s1005-accounts';
import type { S1005 } from '../../src/ro/annual/s1005';

/** Lei with bani as written, '1200.30', to bani. */
const bani = (lei: string) => {
  const [units, fraction = ''] = lei.split('.');
  return BigInt(units!) * 100n + BigInt(fraction.padEnd(2, '0'));
};
type Rows = S1005LedgerEntry['rows'];
export const debit = (account: string, lei: string, rows?: Rows): S1005LedgerEntry => ({
  account,
  debit: bani(lei),
  credit: 0n,
  ...(rows ? { rows } : {}),
});
export const credit = (account: string, lei: string, rows?: Rows): S1005LedgerEntry => ({
  account,
  debit: 0n,
  credit: bani(lei),
  ...(rows ? { rows } : {}),
});
/** Liabilities due within a year (F10 rd. 13). */
const current = { F10: '13' } as const;

/**
 * Exemplu Servicii SRL, a VAT-registered software microenterprise in Galați with two employees,
 * paying the 1% micro tax: 2024 and 2025, a server bought in 2025, the 2024 profit carried to
 * 117 and 50,000 lei of it distributed and paid in 2025.
 */
export const services = {
  turnover2024: [
    credit('704', '120000.40'),
    credit('766', '12.35'),
    credit('765', '30.11'),
    debit('6022', '1200.30'),
    debit('6052', '180.00'),
    debit('611', '500.00'),
    debit('6123', '6000.00'),
    debit('626', '1200.00'),
    debit('627', '300.00'),
    debit('628', '3600.00'),
    debit('641', '36000.00'),
    debit('646', '810.00'),
    debit('6811', '1000.00'),
    debit('635', '50.00'),
    debit('665', '23.47'),
    debit('698', '1200.43'),
  ],
  closing2024: [
    credit('1012', '200.00'),
    credit('1061', '40.00'),
    credit('1171', '4999.85'),
    credit('121', '67978.66'),
    debit('214', '6000.00'),
    credit('2814', '1000.00'),
    debit('4111', '12000.00'),
    debit('5121', '65936.44'),
    debit('5311', '300.00'),
    credit('401', '2500.00', current),
    credit('4423', '1900.00', current),
    credit('4418', '300.43', current),
    credit('421', '3000.00', current),
    credit('4315', '1250.00', current),
    credit('4316', '500.00', current),
    credit('436', '67.50', current),
    credit('444', '500.00', current),
  ],
  turnover2025: [
    credit('704', '150000.40'),
    credit('766', '45.10'),
    credit('765', '30.11'),
    debit('6022', '1500.30'),
    debit('6028', '450.00'),
    debit('6051', '900.00'),
    debit('6052', '240.00'),
    debit('611', '700.00'),
    debit('6123', '7200.00'),
    debit('626', '1350.55'),
    debit('627', '320.00'),
    debit('628', '4200.00'),
    debit('641', '48000.00'),
    debit('646', '1080.00'),
    debit('6811', '1500.00'),
    debit('635', '60.00'),
    debit('6588', '15.25'),
    debit('665', '23.47'),
    debit('698', '1500.76'),
  ],
  closing2025: [
    credit('1012', '200.00'),
    credit('1061', '40.00'),
    credit('1171', '22978.51'),
    credit('121', '81035.28'),
    debit('2131', '8000.00'),
    debit('214', '6000.00'),
    credit('2813', '500.00'),
    credit('2814', '2000.00'),
    debit('4111', '18500.00'),
    debit('471', '600.00', { F10: '11' }),
    debit('5121', '86353.98'),
    debit('5311', '250.00'),
    credit('401', '3100.00', current),
    credit('4423', '2400.00', current),
    credit('4418', '380.19', current),
    credit('421', '4000.00', current),
    credit('4315', '1650.00', current),
    credit('4316', '660.00', current),
    credit('436', '90.00', current),
    credit('444', '520.00', current),
    credit('462', '150.00', current),
  ],
};

export const header: Omit<S1005, 'F10' | 'F20' | 'F30' | 'F40'> = {
  year: 2025,
  entity: {
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    address: { locality: 'Galați', street: 'Str. Lungă', number: '10' },
    phone: '0236000000',
    tradeRegister: 'J17/123/2010',
    county: 17,
    ownership: 35,
    caen: '6210',
    caenActual: '6210',
    caenVersion: 2025,
    largeTaxpayer: false,
    branch: false,
    economicInterestGroup: false,
    netAssetsBelowHalfCapital: false,
  },
  administrator: 'Popescu Ana',
  preparer: { name: 'Ionescu Maria', quality: 22, membership: '12345', cif: '14399840' },
  approved: true,
};

/** The services company's statements: F10, F20 and F30 chapter XIX from the ledger, the rest as
 * its registers give them. */
export function servicesStatements(): S1005 {
  const previous = s1005FromLedger({
    closing: services.closing2024,
    turnover: services.turnover2024,
  });
  const currentYear = s1005FromLedger({
    closing: services.closing2025,
    turnover: services.turnover2025,
  });
  const columns = s1005Columns({ previous, current: currentYear });
  return {
    ...header,
    F10: columns.F10,
    // All turnover is software development, the main activity (CAEN 6210).
    F20: { ...columns.F20, '01a': [120_000, 150_000] },
    F30: {
      ...columns.F30,
      '167a': [120_000, 150_000],
      // III. Average and year-end number of employees.
      '19': [2, 2],
      '20': [2, 2],
      // VIII. Gross trade receivables, cash, bank accounts, debts and paid-in capital.
      '57': [12_000, 18_500],
      '82': [300, 250],
      '83': [300, 250],
      '85': [65_936, 86_354],
      '86': [65_936, 86_354],
      '106': [2500, 3100],
      '108': [3000, 4000],
      '110': [1750, 2310],
      '111': [2768, 3390],
      '118': [0, 150],
      '126': [200, 200],
      '129': [200, 200],
      // XII. Paid-in capital, held by individuals.
      '137': [200, undefined, 200],
      '147': [200, 100, 200, 100],
    },
    // The laptop (214, 3 years) and the 2025 server (2131).
    F40: {
      '10': [0, 8000, 0, 0, 8000],
      '11': [6000, 0, 0, 0, 6000],
      '29': [0, 500, 0, 500],
      '30': [1000, 1000, 0, 2000],
    },
  };
}

/**
 * Atelier Nou SRL, set up in 2025 in Bucharest's sector 3 with 1,000 lei of capital and a
 * 5,000 lei shareholder loan due in 2027: a loss in its first year, net assets below half of the
 * capital, no fixed assets and no previous year.
 */
export const startup = {
  turnover2025: [
    credit('704', '20000.00'),
    debit('628', '15000.25'),
    debit('641', '8000.00'),
    debit('646', '180.00'),
    debit('6022', '310.49'),
    debit('698', '200.00'),
  ],
  closing2025: [
    credit('1012', '1000.00'),
    debit('121', '3690.74'),
    debit('4111', '2000.00'),
    debit('5121', '2397.26'),
    credit('401', '500.00', current),
    credit('421', '1000.00', current),
    credit('4315', '300.00', current),
    credit('4316', '120.00', current),
    credit('436', '18.00', current),
    credit('444', '100.00', current),
    credit('4418', '50.00', current),
    credit('455', '5000.00', { F10: '16' }),
  ],
};

export function startupStatements(): S1005 {
  const year = s1005FromLedger({ closing: startup.closing2025, turnover: startup.turnover2025 });
  const columns = s1005Columns({ current: year });
  return {
    ...header,
    entity: {
      ...header.entity,
      cui: '14399840',
      name: 'Atelier Nou SRL',
      address: { sector: 3, locality: 'București', street: 'Str. Fizicienilor', number: '7' },
      phone: undefined,
      tradeRegister: 'J2025012345400',
      county: 40,
      caen: '7311',
      caenActual: '7311',
      netAssetsBelowHalfCapital: true,
    },
    administrator: 'Marinescu Dan',
    preparer: { name: 'Marinescu Dan', quality: 13 },
    F10: columns.F10,
    F20: columns.F20,
    F30: { ...columns.F30, '19': [undefined, 1], '20': [undefined, 1] },
    F40: {},
  };
}
