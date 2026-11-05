import { describe, expect, test } from 'bun:test';
import { draftDocuments, owedDocuments, type DraftFacts } from '../src/ro/annual/documents';
import { halfYearReport } from '../src/ro/annual/half-year';
import {
  informativeRows,
  s1003InformativeSpec,
  type AnnualYearBooks,
} from '../src/ro/annual/informative';
import {
  checkS1003,
  completeS1003,
  s1003ComputedCells,
  s1003Controls,
  s1003F20Rows,
  s1003F30Rows,
  s1003Field,
  s1003Format,
  writeS1003,
} from '../src/ro/annual/s1003';
import { s1003F20Formulas, s1003FromLedger } from '../src/ro/annual/s1003-accounts';
import { s1005F30Formulas } from '../src/ro/annual/s1005-accounts';
import { checkS1046, s1046Format, writeS1046, type S1046 } from '../src/ro/annual/s1046';
import { obligationDue } from '../src/ro/obligations';
import { roRegister } from '../src/ro/register';
import { RuleContext, RuleGapError } from '../src/rules';
import type { LocalDate } from '../src/time';
import { consulting, consultingStatements } from './fixtures/s1003';

const rules = () => new RuleContext(roRegister(), 'preview');
const errors = (model: Parameters<typeof checkS1003>[0]) =>
  checkS1003(model)
    .filter((check) => check.severity === 'error')
    .map((check) => check.code)
    .sort();

describe('S1003, the small entities’ statements for 2025', () => {
  test('the forms as ANAF’s structure gives them: F20 in full, F30 of the larger entities', () => {
    expect(s1003F20Rows).toHaveLength(84);
    expect(s1003F30Rows).toHaveLength(195);
    expect(s1003Field('F20', '01a', 2)).toBe('F20_3012');
    expect(s1003Field('F20', '69', 2)).toBe('F20_0692');
    expect(s1003Field('F30', '165a', 1)).toBe('F30_3121');
    // The null rows of the structure are not fields.
    expect(() => s1003Field('F20', '05', 1)).toThrow('F20 nu are rândul 05');
    expect(s1003Controls.length).toBeGreaterThan(290);
    const byCode = new Map(s1003Controls.map((control) => [control.code, control]));
    expect(byCode.get('F20_1')?.text).toBe('F20_0011 = F20_0021 + F20_0031 - F20_0041 + F20_0061');
    expect(byCode.get('F10_F20_3')?.text).toBe('F10_0432 = F20_0692');
    expect(s1003Format(2025).namespace).toBe('mfp:anaf:dgti:s1003:declaratie:v15');
    expect(() => s1003Format(2026)).toThrow('ANAF nu a publicat formatul pentru 2026');
  });

  test('F20 reads the accounts of the microentities’ chapter XIX, row for row', () => {
    expect(s1003F20Formulas).toHaveLength(s1005F30Formulas.length);
    const year = s1003FromLedger({
      closing: consulting.closing2025,
      turnover: consulting.turnover2025,
    });
    expect(year.issues).toEqual([]);
    expect(year.F20).toMatchObject({
      '02': 5_200_000,
      '17': 55_000,
      '32': 1_410_000,
      '33': 130_000,
      '33c': 130_000,
      '23': 2_200_000,
      '24': 49_500,
      '25a': 30_000,
      '47': 3_000,
      '66': 212_560,
    });
    expect(year.F10).toMatchObject({ '08': 3_589_980, '30': 200_000, '43': 1_115_940 });
  });

  test('the writer completes and checks the form; a given total that disagrees is refused', () => {
    const model = consultingStatements();
    expect(checkS1003(model)).toEqual([]);
    const filed = completeS1003(model);
    expect(filed.F20['16']).toEqual([4_800_000, 5_200_000]);
    expect(filed.F20['64']).toEqual([1_256_000, 1_328_500]);
    expect(filed.F30['01']).toEqual([1, 1_115_940]);
    expect(filed.F30['111']).toEqual([415_000, 449_000]);
    const xml = writeS1003(model);
    expect(xml).toContain('<Bilant1003 xmlns="mfp:anaf:dgti:s1003:declaratie:v15"');
    expect(xml).toContain('tipBIL="BS"');
    expect(xml).toContain('totalPlata_A="200000"');
    // Informative rows with nothing to report are left out; chapter I keeps its zeros.
    expect(xml).not.toContain('F30_0211=');
    expect(xml).toContain('F30_0021="0"');
    expect(errors({ ...filed, F20: { ...filed.F20, '69': [1_055_040, 1_115_941] } })).toEqual([
      'F10_F20_3',
      'F10_F30_1',
      'F20_40',
    ]);
    expect(
      errors({ ...filed, F30: { ...filed.F30, '151': [200_000, 100, 200_000, 101] } }),
    ).toEqual(['F30_98']);
    expect(errors({ ...filed, year: 2026 })).toEqual(['S1003_YEAR']);
  });
});

const empty = (year: number): AnnualYearBooks => ({
  year,
  closing: [],
  turnover: [],
  openItems: [],
  headcount: Array.from({ length: 12 }, () => 0),
  employeesAtEnd: 0,
  dividends: { retained: 0n, interim: 0n },
});

describe('F30 from the registers', () => {
  const spec = s1003InformativeSpec(s1003ComputedCells('F30'));
  test('balances, partners, overdue items and employees from the books; the rest asked by chapter', () => {
    const current: AnnualYearBooks = {
      ...empty(2025),
      closing: [
        { account: '5121', bani: 350_000_00n },
        { account: '4111', bani: 120_000_00n, partner: { country: 'RO', kind: 'ro_legal_entity' } },
        { account: '4111', bani: 30_000_00n, partner: { country: 'DE', kind: 'eu_taxable' } },
        { account: '401', bani: -40_000_00n, partner: { country: 'RO', kind: 'ro_legal_entity' } },
        { account: '1012', bani: -200_00n },
      ],
      openItems: [
        {
          account: '401',
          bani: 25_000_00n,
          dueDate: '2025-10-15',
          partner: { country: 'RO', kind: 'ro_legal_entity' },
        },
        {
          account: '401',
          bani: 15_000_00n,
          dueDate: '2025-12-20',
          partner: { country: 'RO', kind: 'ro_legal_entity' },
        },
        {
          account: '4111',
          bani: 30_000_00n,
          dueDate: '2025-11-30',
          partner: { country: 'DE', kind: 'eu_taxable' },
        },
      ],
      headcount: [2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3],
      employeesAtEnd: 3,
    };
    const result = informativeRows(spec, { form: 'srl', current, previous: null }, {});
    // Bank, gross trade receivables, the supplier overdue 77 days (over 30), employees.
    expect(result.rows['88']).toEqual([undefined, 350_000]);
    expect(result.rows['57']).toEqual([undefined, 150_000]);
    expect(result.rows['06']).toEqual([25_000, 25_000, 0]);
    expect(result.rows['07']).toEqual([0, 0, 0]);
    expect(result.rows['19']).toEqual([undefined, 3]);
    expect(result.rows['20']).toEqual([undefined, 3]);
    expect(result.rows['34']).toEqual([30_000]);
    expect(result.rows['133']).toEqual([undefined, 200]);
    // A non-resident customer: whether it is affiliated the books do not keep, so asked.
    const viii = result.asks.find((ask) => ask.chapter === 'VIII')!;
    expect(viii.rows.map((row) => row.row)).toContain('58');
    expect(viii.rows.map((row) => row.row)).not.toContain('88');
    // The state/private split of overdue receivables is asked, as is every unknown chapter.
    expect(result.asks.find((ask) => ask.chapter === 'IV')!.rows.map((row) => row.row)).toContain(
      '35',
    );
    expect(result.missing.map((ask) => ask.chapter)).toEqual(result.asks.map((ask) => ask.chapter));
    // An answer fills its chapter; "none" is zero, a row outside the chapter is refused.
    const answered = informativeRows(
      spec,
      { form: 'srl', current, previous: null },
      { VI: { none: true }, X: { rows: { '137': [null, 5], '999': [1] } } },
    );
    expect(answered.rows['38']).toEqual([undefined, 0]);
    expect(answered.rows['137']).toEqual([undefined, 5]);
    expect(answered.issues.map((issue) => issue.row)).toEqual(['138', '139', '999']);
  });

  test('a supplier invoice without a due date makes the overdue payments a question', () => {
    const current: AnnualYearBooks = {
      ...empty(2025),
      openItems: [
        {
          account: '401',
          bani: 1_000_00n,
          dueDate: null,
          partner: { country: 'RO', kind: 'ro_legal_entity' },
        },
      ],
    };
    const result = informativeRows(spec, { form: 'srl', current, previous: null }, {});
    expect(result.rows['06']).toBeUndefined();
    expect(result.asks.find((ask) => ask.chapter === 'II')!.rows.map((row) => row.row)).toContain(
      '06',
    );
  });
});

describe('the accompanying documents', () => {
  const facts: DraftFacts = {
    statement: 'S1003',
    year: 2025,
    company: {
      name: 'Exemplu Consultanță SRL',
      cui: '14399840',
      tradeRegister: 'J17/456/2015',
      address: 'Str. Lungă 10, Galați',
      form: 'srl',
    },
    administrator: 'Popescu Ana',
    preparer: { name: 'Contexpert SRL', quality: 22 },
    turnover: [4_800_000, 5_200_000],
    result: 1_115_940,
    previousResult: 1_055_040,
    equity: 3_911_000,
    totalAssets: 4_650_000,
    debts: 739_000,
    legalReserve: 0,
    capital: 200_000,
    employees: { average: 11, atEnd: 11 },
    fixedAssets: { '10': [150_000, 0, 0, 0, 150_000], '34': [60_000, 30_000, 0, 90_000] },
    policies: { 'policy.storno': 'red' },
    disclosures: null,
    branch: false,
  };
  test('owed by law: the notes, the administrators’ report, the proposal, the declaration, the audit report', () => {
    expect(owedDocuments('S1003', undefined).map((item) => item.document)).toEqual([
      'notes',
      'administrators.report',
      'profit.distribution',
      'declaration',
    ]);
    expect(
      owedDocuments('S1003', { kind: 'statutory' }).map((item) => [item.document, item.drafted]),
    ).toContainEqual(['audit.report', false]);
    expect(owedDocuments('S1005', { kind: 'censors' }).at(-1)!.document).toBe('censors.report');
  });

  test('the drafts: the declaration’s content is the law’s; the judgments are left to the administrator', () => {
    const drafts = draftDocuments(facts);
    const declaration = drafts.find((draft) => draft.document === 'declaration')!;
    expect(declaration.text).toContain('a) politicile contabile utilizate');
    expect(declaration.text).toContain('[de completat de administrator]');
    const answered = draftDocuments({
      ...facts,
      disclosures: {
        parent: null,
        commitments: null,
        managementAdvances: null,
        exceptional: null,
        longTermDebts: null,
        subsequentEvents: null,
        relatedParties: null,
        goingConcern: { continues: true, uncertainty: null },
        evidenceIds: [],
      },
    });
    const again = answered.find((draft) => draft.document === 'declaration')!;
    expect(again.text).toContain(
      'c) persoana juridică își desfășoară activitatea în condiții de continuitate.',
    );
    expect(again.hash).not.toBe(declaration.hash);
    const notes = drafts.find((draft) => draft.document === 'notes')!.text;
    expect(notes).toContain('Stornările se fac în roșu.');
    expect(notes).toContain('| Instalații tehnice și mașini | 150.000 | 0 | 0 | 150.000 |');
    expect(notes).toContain('11 salariați în medie în 2025');
    const proposal = drafts.find((draft) => draft.document === 'profit.distribution')!.text;
    expect(proposal).toContain('Profitul net al exercițiului 2025: 1.115.940 lei.');
  });
});

describe('the half-year report, the inactivity declaration and the deadlines', () => {
  test('2025: above 1.000.000 € of the previous turnover; 2026: no order; later: a gap', () => {
    const rate = { rate: '4.9741', date: '2024-12-31' };
    expect(
      halfYearReport(2025, { previousNetTurnover: 5_200_000_00n, rate, excluded: null }, rules()),
    ).toMatchObject({ status: 'required', due: '2025-08-18' });
    expect(
      halfYearReport(2025, { previousNetTurnover: 4_800_000_00n, rate, excluded: null }, rules())
        .status,
    ).toBe('none');
    expect(
      halfYearReport(2025, { previousNetTurnover: null, rate, excluded: null }, rules()),
    ).toMatchObject({ status: 'unknown', missing: ['cifra de afaceri netă 2024'] });
    expect(
      halfYearReport(
        2026,
        { previousNetTurnover: 9_000_000_00n, rate: null, excluded: null },
        rules(),
      ).status,
    ).toBe('none');
    expect(() =>
      halfYearReport(2027, { previousNetTurnover: 0n, rate, excluded: null }, rules()),
    ).toThrow(RuleGapError);
  });

  test('S1046 for 2025, its checks; no format for 2026', () => {
    const model: S1046 = {
      year: 2025,
      yearEnd: '2025-12-31',
      entityKind: 1,
      entity: {
        cui: '18547290',
        name: 'Exemplu Inactiv SRL',
        address: { locality: 'Galați' },
        tradeRegister: 'J17/123/2024',
        county: 17,
        largeTaxpayer: false,
      },
      capital: 200,
      declarant: 'Popescu Ana',
    };
    expect(checkS1046(model)).toEqual([]);
    expect(writeS1046(model)).toContain('tipBIL="DI" codTT="17" codJJ="17" capital="200"');
    expect(checkS1046({ ...model, capital: -1 }).map((check) => check.code)).toEqual([
      'S1046_CAPITAL',
    ]);
    expect(() => s1046Format(2026)).toThrow(
      'S1046 se scrie aici doar pentru exercițiul financiar 2025',
    );
  });

  test('the statements’ deadline: the law’s 150 days against the order’s 31 May, both shown', () => {
    const period = (year: number) => ({
      start: `${year}-01-01` as LocalDate,
      end: `${year}-12-31` as LocalDate,
    });
    const due = obligationDue('S1003', period(2025), rules());
    expect(due).toMatchObject({ nominal: '2026-05-30', due: '2026-06-02' });
    expect(due.conflict?.map((reading) => [String(reading.nominal), reading.clauses])).toEqual([
      ['2026-05-30', ['L82/1991:art.36(1)(a)']],
      ['2026-05-31', ['OMF2036/2025:anexa1.pct.3.1(1)(a)']],
    ]);
    expect(obligationDue('S1005', period(2025), rules()).conflict).toHaveLength(2);
    // 2026: no order yet, the law alone.
    expect(obligationDue('S1003', period(2026), rules())).toMatchObject({
      nominal: '2027-05-30',
      due: '2027-05-31',
    });
    expect(obligationDue('S1003', period(2026), rules()).conflict).toBeUndefined();
    // The inactivity declaration: 60 days.
    expect(String(obligationDue('S1046', period(2025), rules()).nominal)).toBe('2026-03-01');
  });
});
