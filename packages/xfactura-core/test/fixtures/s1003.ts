// An invented small entity's ledgers and statements for 2025, shared by the S1003 unit tests and
// the official validation (scripts/validators/official-s1003.test.ts).
import { s1003FromLedger } from '../../src/ro/annual/s1003-accounts';
import { s1005Columns } from '../../src/ro/annual/s1005-accounts';
import type { S1003 } from '../../src/ro/annual/s1003';
import { credit, debit, header } from './s1005';

/** Liabilities due within a year (F10 rd. 13). */
const current = { F10: '13' } as const;

/**
 * Exemplu Consultanță SRL, a profit-tax payer in Galați: above 2.250.000 lei of total assets and
 * 4.500.000 lei of net turnover in 2024 and in 2025, so a small entity in 2025 (OMF nr. 2.036/2025
 * anexa nr. 1 pct. 2.1–2.2; OMFP nr. 1.802/2014 pct. 12–13), with ten, then eleven, employees.
 */
export const consulting = {
  turnover2024: [
    credit('704', '4800000.00'),
    credit('766', '2000.00'),
    debit('6022', '50000.00'),
    debit('611', '100000.00'),
    debit('6123', '120000.00'),
    debit('628', '1200000.00'),
    debit('641', '2000000.00'),
    debit('646', '45000.00'),
    debit('6811', '30000.00'),
    debit('665', '1000.00'),
    debit('691', '200960.00'),
  ],
  closing2024: [
    credit('1012', '200000.00'),
    credit('1061', '40000.00'),
    credit('1171', '1500000.00'),
    credit('121', '1055040.00'),
    debit('2131', '150000.00'),
    credit('2813', '60000.00'),
    debit('4111', '900000.00'),
    debit('5121', '2490040.00'),
    credit('401', '150000.00', current),
    credit('421', '120000.00', current),
    credit('4315', '50000.00', current),
    credit('4316', '20000.00', current),
    credit('444', '25000.00', current),
    credit('4411', '20000.00', current),
    credit('4423', '300000.00', current),
  ],
  turnover2025: [
    credit('704', '5200000.00'),
    credit('766', '3000.00'),
    debit('6022', '55000.00'),
    debit('611', '110000.00'),
    debit('6123', '130000.00'),
    debit('628', '1300000.00'),
    debit('641', '2200000.00'),
    debit('646', '49500.00'),
    debit('6811', '30000.00'),
    debit('691', '212560.00'),
  ],
  closing2025: [
    credit('1012', '200000.00'),
    credit('1061', '40000.00'),
    credit('1171', '2555040.00'),
    credit('121', '1115940.00'),
    debit('2131', '150000.00'),
    credit('2813', '90000.00'),
    debit('4111', '1000000.00'),
    debit('5121', '3589980.00'),
    credit('401', '160000.00', current),
    credit('421', '130000.00', current),
    credit('4315', '55000.00', current),
    credit('4316', '22000.00', current),
    credit('444', '27000.00', current),
    credit('4411', '25000.00', current),
    credit('4423', '320000.00', current),
  ],
};

/** The consulting company's statements: F10 and F20 from the ledger, F30 and F40 as its
 * registers give them. */
export function consultingStatements(): S1003 {
  const previous = s1003FromLedger({
    closing: consulting.closing2024,
    turnover: consulting.turnover2024,
  });
  const currentYear = s1003FromLedger({
    closing: consulting.closing2025,
    turnover: consulting.turnover2025,
  });
  const columns = s1005Columns({ previous, current: currentYear });
  return {
    ...header,
    entity: {
      ...header.entity,
      cui: '14399840',
      name: 'Exemplu Consultanță SRL',
      caen: '7022',
      caenActual: '7022',
    },
    preparer: { name: 'Ionescu Maria', quality: 22, membership: '12345', cif: '18547290' },
    F10: columns.F10,
    // All turnover is the main activity (CAEN 7022).
    F20: { ...columns.F20, '01a': [4_800_000, 5_200_000] } as S1003['F20'],
    F30: {
      // III. Average and year-end number of employees.
      '19': [10, 11],
      '20': [10, 11],
      // VIII. Gross trade receivables, bank accounts, debts and paid-in capital.
      '57': [900_000, 1_000_000],
      '87': [2_490_040, 3_589_980],
      '88': [2_490_040, 3_589_980],
      '108': [150_000, 160_000],
      '110': [120_000, 130_000],
      '112': [70_000, 77_000],
      '113': [345_000, 372_000],
      '130': [200_000, 200_000],
      '133': [200_000, 200_000],
      // XII. Paid-in capital, held by individuals.
      '141': [200_000, undefined, 200_000],
      '151': [200_000, 100, 200_000, 100],
    },
    // The building works (2131) and their depreciation.
    F40: {
      '10': [150_000, 0, 0, 0, 150_000],
      '29': [60_000, 30_000, 0, 90_000],
    },
  };
}
