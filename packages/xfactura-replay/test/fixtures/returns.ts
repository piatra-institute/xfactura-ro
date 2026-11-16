import { writeD100 } from 'xfactura-core/ro/declarations/d100';
import {
  writeD112,
  type D112Insured,
  type D112SickCertificate,
} from 'xfactura-core/ro/declarations/d112';
import { writeD205 } from 'xfactura-core/ro/declarations/d205';
import { writeD300 } from 'xfactura-core/ro/declarations/d300';
import { writeD390 } from 'xfactura-core/ro/declarations/d390';
import { writeD394, type D394Operation } from 'xfactura-core/ro/declarations/d394';
import { writeS1005 } from 'xfactura-core/ro/annual/s1005';
import { servicesStatements } from '../../../xfactura-core/test/fixtures/s1005';

// Synthetic inputs from core/test/{d100,d112,d205,d300,d390,d394}.test.ts. Those files do
// not export their models; keep these small input copies instead of importing test suites.
const company = {
  cui: '18547290',
  name: 'Exemplu Servicii SRL',
  address: 'Str. Lungă nr. 10, Galați',
};
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };

export function vatReturn(year: 2025 | 2026) {
  return writeD300({
    period: { year, month: 9 },
    type: 'L',
    company: {
      ...company,
      bank: 'Banca Exemplu',
      account: 'RO49AAAA1B31007593840000',
      caen: '6201',
    },
    declarant,
    groupRepresentative: false,
    simplifiedDomestic: false,
    afterReserveCancellation: false,
    proRata: '100',
    reverseCharge: {
      cereals: false,
      mobilePhones: false,
      integratedCircuits: false,
      consoles: false,
    },
    refundRequested: false,
    rows: { R9_1: 1000, R9_2: 210, R22_1: 500, R22_2: 105, R28_2: 105 },
  });
}

export function domesticReturn() {
  const operation = (code: string, base: number): D394Operation => ({
    type: 'L',
    rate: '21',
    partner: { kind: 'registered', cui: code, name: 'Client Unu SRL' },
    invoices: 1,
    base,
    vat: 210,
  });
  return writeD394({
    period: { year: 2026, month: 9 },
    type: 'T',
    company: { ...company, caen: '6201', phone: '0236000000' },
    representative: { name: 'Popescu Ana', role: 'Administrator', address: company.address },
    preparer: { kind: 'company', cui: company.cui, name: company.name, capacity: 'Administrator' },
    consultation: false,
    affiliates: false,
    operations: [
      operation('14399840', 1000),
      operation('13548146', 1000),
      { ...operation('10376500', 2000), rate: '11', vat: 220 },
      {
        ...operation('16341004', 1500),
        type: 'C',
        vat: 315,
        products: [
          { code: '22', invoices: 1, base: 1000, vat: 210 },
          { code: '23', invoices: 1, base: 500, vat: 105 },
        ],
      },
      {
        type: 'L',
        rate: '21',
        partner: {
          kind: 'unregistered',
          name: 'Georgescu Elena',
          address: { country: 'RO', county: 'RO-GL', locality: 'Galați', street: 'Str. Brăilei' },
        },
        invoices: 1,
        base: 300,
        vat: 63,
      },
    ],
    simplified: {},
    series: [
      { type: 'allocated', series: 'XF', first: '1', last: '99999' },
      { type: 'issued', series: 'XF', first: '101', last: '104' },
    ],
    issuedInvoices: { own: 4, byBeneficiaries: 0, byThirdParties: 0 },
    invoices: [
      { type: 'storno', series: 'XF', number: '101' },
      { type: 'cancelled', series: 'XF', number: '102' },
    ],
    cashVatDeductible: {},
    cashRegisters: [7, 8].map((month) => ({
      month,
      registers: 1,
      receipts: 1,
      total: 121,
      byRate: { '21': { base: 100, vat: 21 } },
    })),
  });
}

export function viesReturn() {
  return writeD390({
    period: { year: 2026, month: 10 },
    rectification: false,
    declarant,
    company,
    operations: [
      { type: 'S', country: 'IE', code: '6388047V', name: 'Supplier Limited', base: 498 },
      { type: 'P', country: 'DE', code: '123456788', name: 'Kunde GmbH', base: 150 },
    ],
  });
}

export function obligationsReturn() {
  return writeD100({
    period: { year: 2026, month: 6 },
    afterReserveCancellation: false,
    dissolution: false,
    declarant,
    payer: company,
    obligations: [
      { kind: 'dividends', beneficiary: 'individual', withheld: 4800 },
      { kind: 'dividends', beneficiary: 'company', withheld: 1600 },
    ],
  });
}

const employee = (): D112Insured => ({
  cnp: '1781105170030',
  lastName: 'Dumitrescu',
  firstName: 'Andrei',
  from: '2023-09-01',
  healthFund: 'RO-GL',
  sickLeaveInsured: true,
  unemploymentInsured: true,
  employment: {
    type: '1',
    pensioner: false,
    contract: 'N',
    normHours: 8,
    baseSalary: 5000,
    hoursWorked: 176,
    hoursSuspended: 0,
    daysWorked: 22,
    unemploymentBase: 5000,
    camBase: 5000,
    cassBase: 5000,
    cass: 500,
    casBase: 5000,
    cas: 1250,
    relief: 0,
  },
  income: {
    mainJob: true,
    cash: 5000,
    mealVouchers: 0,
    holidayVouchers: 0,
    dependents: 0,
    deduction: { basic: 562, young: 0, children: 0 },
    otherDeductions: 0,
    taxBase: 2688,
    tax: 269,
    paid: 2981,
  },
});

export function payrollReturn(half: 1 | 2) {
  const certificate: D112SickCertificate = {
    series: 'CCMAM',
    number: '1001',
    issued: '2026-10-05',
    from: '2026-10-05',
    to: '2026-10-09',
    code: '01',
    place: 'family_doctor',
    diagnosis: '101',
    unpaidDays: 1,
    employerDays: 4,
    fundDays: 0,
    base: { income: 36000, days: 127 },
    percent: '55',
    employer: 624,
    fund: 0,
  };
  const certificates: D112SickCertificate[] = [
    certificate,
    {
      ...certificate,
      number: '1002',
      issued: '2026-10-19',
      from: '2026-10-19',
      to: '2026-10-28',
      employerDays: 5,
      fundDays: 2,
      percent: '65',
      employer: 921,
      fund: 368,
    },
  ];
  if (half === 1) {
    certificates[0] = {
      ...certificate,
      issued: '2026-03-02',
      from: '2026-03-02',
      to: '2026-03-06',
    };
    certificates[1] = {
      ...certificates[1]!,
      issued: '2026-03-16',
      from: '2026-03-16',
      to: '2026-03-25',
    };
  }
  const ordinary = employee();
  const sick: D112Insured = {
    ...employee(),
    cnp: '2931204170043',
    lastName: 'Constantinescu',
    firstName: 'Ioana',
    from: '2022-06-01',
    sickLeave: certificates,
    employment: {
      ...ordinary.employment,
      baseSalary: 6000,
      hoursWorked: 72,
      hoursSuspended: 104,
      daysWorked: 9,
      unemploymentBase: 4368,
      camBase: 4000,
      cassBase: 4368,
      cass: 437,
      casBase: 4368,
      cas: 1092,
    },
    income: {
      ...ordinary.income,
      cash: 4368,
      deduction: { basic: 843, young: 0, children: 0 },
      taxBase: 1996,
      tax: 200,
      paid: 2639,
    },
  };
  return writeD112({
    period: { year: 2026, month: half === 1 ? 3 : 10 },
    correction: false,
    declarant,
    employer: {
      ...company,
      caen: '6201',
      registeredOffice: { address: company.address },
      healthFund: 'RO-GL',
    },
    insured: [ordinary, sick],
    ...(half === 1 ? { parameters: { minimumWage: 4050, relief: 300 } } : {}),
  });
}

export function beneficiariesReturn() {
  return writeD205({
    year: 2026,
    correction: false,
    declarant,
    payer: company,
    paidAs: 'gross',
    beneficiaries: [
      {
        kind: 'individual',
        cnp: '1781105170030',
        name: 'Dumitrescu Andrei',
        payments: [{ date: '2026-06-15', distributed: '2026-04-20', gross: 30000, tax: 4800 }],
        unpaid: [],
        interest: [{ date: '2026-06-15', gross: 1000, tax: 100 }],
      },
      {
        kind: 'individual',
        cnp: '2850722170021',
        name: 'Georgescu Elena',
        payments: [
          { date: '2026-06-15', distributed: '2026-04-20', gross: 12000, tax: 1920 },
          { date: '2026-11-16', distributed: '2026-04-20', gross: 8000, tax: 1280 },
        ],
        unpaid: [],
      },
    ],
  });
}

export const returnFixtures = [
  { id: 'D300-2025-08', write: () => vatReturn(2025), amount: '@R9_1', text: '@den' },
  { id: 'D300-2026-01', write: () => vatReturn(2026), amount: '@R9_1', text: '@den' },
  { id: 'D394-2025-08', write: domesticReturn, amount: 'op1/@baza', text: '@den' },
  { id: 'D390-v3', write: viesReturn, amount: 'operatie/@baza', text: '@den' },
  { id: 'D100-v2', write: obligationsReturn, amount: 'obligatie/@suma_dat', text: '@den' },
  {
    id: 'D112-2026-01',
    write: () => payrollReturn(1),
    amount: 'asigurat/asiguratA/@A_sal1',
    text: '@nume_declar',
  },
  {
    id: 'D112-2026-07',
    write: () => payrollReturn(2),
    amount: 'asigurat/asiguratA/@A_sal1',
    text: '@nume_declar',
  },
  { id: 'D205-v3', write: beneficiariesReturn, amount: 'benef/@baza1', text: '@den' },
  {
    id: 'S1005-2025',
    write: () => writeS1005(servicesStatements()),
    amount: 'F10/@F10_0012',
    text: '@den',
  },
] as const;
