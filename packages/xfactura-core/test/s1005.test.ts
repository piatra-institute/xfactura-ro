import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { DomainError } from '../src/errors';
import {
  checkS1005,
  completeS1005,
  s1005AddressText,
  s1005Controls,
  s1005F10Rows,
  s1005F20Rows,
  s1005F30Rows,
  s1005F40Rows,
  s1005Field,
  s1005Format,
  s1005Namespace,
  writeS1005,
  type S1005,
} from '../src/ro/annual/s1005';
import {
  s1005Columns,
  s1005F10Formulas,
  s1005F20Formulas,
  s1005F30Formulas,
  s1005Formulas,
  s1005FromLedger,
  type S1005LedgerEntry,
} from '../src/ro/annual/s1005-accounts';
import {
  credit,
  debit,
  header,
  services,
  servicesStatements,
  startupStatements,
} from './fixtures/s1005';

const codes = (model: S1005) => checkS1005(model).map((check) => `${check.severity}:${check.code}`);
const errors = (model: S1005) =>
  checkS1005(model)
    .filter((check) => check.severity === 'error')
    .map((check) => check.code);
const current = { F10: '13' } as const;

describe('S1005 format', () => {
  test('2025 is written in the v15 namespace; other years are refused, not guessed', () => {
    expect(s1005Namespace(2025)).toBe('mfp:anaf:dgti:s1005:declaratie:v15');
    expect(s1005Format(2025).validator).toBe('S1005Validator J14.0.3 (17.03.2026)');
    for (const year of [2024, 2026]) {
      expect(() => s1005Namespace(year)).toThrow(DomainError);
      expect(errors({ ...servicesStatements(), year })).toContain('S1005_YEAR');
      expect(() => writeS1005({ ...servicesStatements(), year })).toThrow(DomainError);
    }
  });

  test('the catalogs give every schema attribute once, without the null rows', () => {
    const fields = (rows: readonly { code: string; columns: readonly number[] }[], form: string) =>
      rows.flatMap((row) => row.columns.map((column) => `${form}_${row.code}${column}`));
    const all = [
      ...fields(s1005F10Rows, 'F10'),
      ...fields(s1005F20Rows, 'F20'),
      ...fields(s1005F30Rows, 'F30'),
      ...fields(s1005F40Rows, 'F40'),
    ];
    expect(new Set(all).size).toBe(all.length);
    // s1005_20260715.xsd: F10 102, F20 26, F30 556 less F30_1711/1712, 2041/2042, 2331/2332 and
    // 3071 (rd. 171, 204, 233 and 161b col. 1 are null), F40 223.
    expect(fields(s1005F10Rows, 'F10')).toHaveLength(102);
    expect(fields(s1005F20Rows, 'F20')).toHaveLength(26);
    expect(fields(s1005F30Rows, 'F30')).toHaveLength(549);
    expect(fields(s1005F40Rows, 'F40')).toHaveLength(223);
    expect(s1005Field('F10', '06a', 1)).toBe('F10_3011');
    expect(s1005Field('F30', '191a', 2)).toBe('F30_3302');
    expect(s1005Field('F40', '10', 5)).toBe('F40_0105');
    expect(() => s1005Field('F30', '161b', 1)).toThrow(DomainError);
  });

  test('every control has a code, and the structure-only ones are warnings', () => {
    expect(s1005Controls.length).toBeGreaterThan(250);
    const byCode = new Map(s1005Controls.map((control) => [control.code, control]));
    expect(byCode.get('F10_63')?.text).toBe(
      'F10_0491 = F10_0041 + F10_0091 + F10_0101 - F10_0131 - F10_0161 - F10_0171 - F10_0181',
    );
    expect(byCode.get('F20_F30_5')?.text).toBe(
      'F20_0071 = F30_2321 + F30_2341 + F30_3281 + F30_3411',
    );
    expect(byCode.get('F40_14')?.text).toBe('F40_0105 = F40_0101 + F40_0102 - F40_0103');
    expect(
      s1005Controls.filter((c) => c.severity === 'warning').map((control) => control.code),
    ).toEqual([
      'F30_45',
      'F30_46',
      'F30_47',
      'F30_48',
      'F30_67',
      'F30_68',
      'F20_F30_5a',
      'F20_F30_6a',
      'F40_32',
    ]);
  });
});

describe('S1005 account formulas', () => {
  const formula = (form: string, row: string) =>
    s1005Formulas.find((item) => item.form === form && item.row === row)!;

  test('the labels are transcribed term by term, with the side each account is read on', () => {
    expect(formula('F10', '01').terms).toEqual([
      { account: '201', sign: 1, amount: 'debit' },
      { account: '203', sign: 1, amount: 'debit' },
      { account: '205', sign: 1, amount: 'debit' },
      { account: '206', sign: 1, amount: 'debit' },
      { account: '2071', sign: 1, amount: 'debit' },
      { account: '4094', sign: 1, amount: 'debit' },
      { account: '208', sign: 1, amount: 'debit' },
      { account: '280', sign: -1, amount: 'credit' },
      { account: '290', sign: -1, amount: 'credit' },
      { account: '4904', sign: -1, amount: 'credit' },
    ]);
    const term = (form: string, row: string, account: string) =>
      formula(form, row).terms.find((item) => item.account === account);
    expect(term('F10', '05', '308')).toEqual({ account: '308', sign: 1, amount: 'debit' });
    expect(term('F10', '05', '4428')).toEqual({
      account: '4428',
      sign: -1,
      amount: 'credit',
      part: true,
    });
    expect(term('F10', '06a', '431')).toEqual({ account: '431', sign: 1, amount: 'debitBalances' });
    expect(term('F10', '06a', '267')).toEqual({
      account: '267',
      sign: 1,
      amount: 'debit',
      part: true,
    });
    expect(term('F10', '13', '431')).toEqual({ account: '431', sign: 1, amount: 'creditBalances' });
    expect(term('F10', '13', '169')).toEqual({ account: '169', sign: -1, amount: 'debit' });
    expect(term('F10', '16', '457')).toBeUndefined();
    expect(term('F10', '38', '109')).toEqual({ account: '109', sign: 1, amount: 'debit' });
    expect(formula('F10', '41')).toMatchObject({ complement: '42' });
    expect(term('F20', '01', '709')).toEqual({ account: '709', sign: -1, amount: 'debit' });
    expect(term('F20', '03', '609')).toEqual({
      account: '609',
      sign: -1,
      amount: 'credit',
      part: true,
    });
    expect(term('F20', '05', '7818')).toEqual({ account: '7818', sign: -1, amount: 'credit' });
    expect(term('F30', '170', '709')).toEqual({ account: '709', sign: 1, amount: 'debit' });
    expect(term('F30', '187', '609')).toEqual({ account: '609', sign: 1, amount: 'credit' });
    expect(formula('F30', '198').terms.map((item) => item.account)).not.toContain('612');
    expect(formula('F30', '192').terms.map((item) => item.account)).not.toContain('6811');
  });

  test('every formula cites its document and row', () => {
    for (const item of s1005Formulas) {
      expect(item.source).toMatch(/rd\. \S+/);
      expect(item.terms.length).toBeGreaterThan(0);
    }
    expect(formula('F10', '06a').source).toBe(
      'ANAF bilant_SC_1225_XML_270326.pdf, F10S rd. 06a (OMF rd. 06); structura_SC_1225_270126.pdf p. 18',
    );
    expect(formula('F30', '191a').source).toBe(
      'OMF nr. 2036/2025 anexa nr. 4 pct. 6, cap. XIX, rd. 207 (M.Of. nr. 41/20.I.2026, p. 48); ANAF bilant_SC_1225_XML_270326.pdf, F30 rd. 191a',
    );
    expect(
      s1005Formulas.filter((item) => item.ambiguity).map((item) => `${item.form}.${item.row}`),
    ).toEqual([
      'F10.01',
      'F10.02',
      'F10.03',
      'F10.05',
      'F10.06a',
      'F10.13',
      'F10.16',
      'F20.01',
      'F20.02',
      'F20.04',
      'F20.05',
      'F20.06',
      'F30.189',
      'F30.192',
      'F30.198',
    ]);
  });

  test('F20 and chapter XIX name the same class 6 and 7 accounts', () => {
    const main = (items: typeof s1005F20Formulas) =>
      items
        .filter((item) => item.of === undefined)
        .flatMap((item) => item.terms.map((t) => t.account));
    const f20 = main(s1005F20Formulas);
    const xix = main(s1005F30Formulas);
    const covered = (account: string, by: readonly string[]) =>
      by.some((prefix) => account.startsWith(prefix) || prefix.startsWith(account));
    expect(f20.filter((account) => !covered(account, xix))).toEqual([]);
    expect(xix.filter((account) => !covered(account, f20))).toEqual([]);
    expect(s1005F10Formulas.every((item) => item.reads === 'closing')).toBe(true);
  });
});

describe('S1005 from the ledger', () => {
  test('the services company: rows in lei, the balance sheet balancing and 121 equal to F20', () => {
    const year = s1005FromLedger({
      closing: services.closing2025,
      turnover: services.turnover2025,
    });
    expect(year.issues).toEqual([]);
    expect(year.F10).toMatchObject({
      '02': 11_500,
      '06a': 18_500,
      '08': 86_604,
      '11': 600,
      '13': 12_950,
      '30': 200,
      '37': 40,
      '41': 22_979,
      '42': 0,
      '43': 81_035,
      '44': 0,
    });
    expect(year.F20).toEqual({
      '01': 150_000,
      '02': 75,
      '03': 1950,
      '04': 49_080,
      '05': 1500,
      '06': 15_009,
      '06a': 900,
      '06b': 0,
      '07': 1501,
      '07a': 0,
    });
    // 6123 is in 198a and its breakdown 198d; 612 is not in 198.
    expect(year.F30).toMatchObject({
      '168': 150_000,
      '185': 1140,
      '185a': 900,
      '198': 6571,
      '198a': 7200,
      '198d': 7200,
      '191a': 1500,
      '213': 45,
      '216': 30,
      '224': 23,
      '234': 1501,
    });
    const model = completeS1005(servicesStatements());
    expect(model.F10['49']).toEqual([73_219, 104_254]);
    expect(model.F10['15']).toEqual([73_219, 104_254]);
    expect(model.F20['08']).toEqual([67_979, 81_035]);
    expect(model.F30['235']).toEqual([67_979, 81_035]);
    expect(model.F30['01']).toEqual([1, 81_035]);
    expect(checkS1005(servicesStatements())).toEqual([]);
  });

  test('rounding keeps the balance sheet and the result exact', () => {
    // Three halves of a leu: each rounds up alone, the sums do not.
    const year = s1005FromLedger({
      closing: [
        credit('1012', '200.00'),
        credit('121', '1.50'),
        debit('5121', '101.50'),
        debit('5311', '100.50'),
        credit('401', '0.50', current),
      ],
      turnover: [credit('704', '10.50'), debit('628', '4.50'), debit('626', '4.50')],
    });
    expect(year.issues).toEqual([]);
    const f10 = year.F10;
    expect(f10['08']! - f10['13']! - f10['30']! - f10['43']!).toBe(0);
    expect(f10['43']).toBe(year.F20['01']! - year.F20['06']!);
    expect(f10['43']).toBe(2);
  });

  test('a bifunctional account goes by its side; one the form spreads needs its row', () => {
    const year = s1005FromLedger({
      closing: [
        credit('1012', '1100.00'),
        debit('5121', '1500.00'),
        debit('4411', '300.00'),
        credit('4418', '200.00', current),
        credit('401', '400.00'),
        credit('1621', '200.00', { F10: '16' }),
        debit('508', '100.00'),
        debit('1171', '100.00'),
        credit('2075', '100.00'),
      ],
      turnover: [],
    });
    expect(year.F10['06a']).toBe(300);
    expect(year.F10['13']).toBe(200);
    expect(year.F10['16']).toBe(200);
    expect(year.F10['41']).toBe(0);
    expect(year.F10['42']).toBe(100);
    expect(year.F10['28']).toBe(100);
    expect(year.issues.map((issue) => `${issue.code} ${issue.path}`)).toEqual([
      'S1005_SPLIT closing.4',
      'S1005_SPLIT closing.6',
    ]);
    expect(year.issues[0]!.message).toBe(
      'Contul 401 se repartizează între rândurile 13, 16 din F10: indicați rândul (rows.F10).',
    );
  });

  test('what the formulas cannot place is reported, never dropped silently', () => {
    const year = s1005FromLedger({
      closing: [
        credit('1012', '200.00'),
        debit('266', '50.00'),
        credit('704', '10.00'),
        debit('5121', '100.00'),
        credit('401', '20.00', { F10: '05' }),
        debit('8035', '999.00'),
        credit('121', '10.00'),
      ],
      turnover: [
        credit('704', '10.00'),
        debit('695', '5.00'),
        debit('609', '0.00'),
        credit('609', '1.00'),
        debit('6818', '1.00'),
        debit('121', '1.00'),
      ],
    });
    expect(year.issues.map((issue) => `${issue.severity}:${issue.code} ${issue.path}`)).toEqual([
      'warning:S1005_TURNOVER turnover.5',
      'error:S1005_NOT_CLOSED closing.2',
      'error:S1005_UNBALANCED closing',
      'error:S1005_RESULT closing',
      'error:S1005_UNMAPPED closing.1',
      'error:S1005_ROW closing.4',
      'error:S1005_UNMAPPED turnover.1',
      'error:S1005_SPLIT turnover.3',
      'error:S1005_UNMAPPED turnover.1',
      'error:S1005_SPLIT turnover.4',
    ]);
  });

  test('assigned rows: 609 between F20 rd. 03 and 06, 6818 in chapter XIX, breakdowns', () => {
    const entries: S1005LedgerEntry[] = [
      credit('7584', '100.00'),
      credit('609', '30.00', { F20: '03' }),
      debit('6818', '40.00', { F30: '195' }),
      debit('6053', '25.00'),
    ];
    const year = s1005FromLedger({ closing: [], turnover: entries });
    expect(year.issues).toEqual([]);
    expect(year.F20).toMatchObject({ '02': 100, '03': -30, '05': 40, '06': 25, '06b': 25 });
    expect(year.F30).toMatchObject({ '179': 100, '180': 100, '187': 30, '195': 40, '185b': 25 });
  });

  test('a balanced ledger always gives statements whose controls hold', () => {
    const cents = fc.bigInt({ min: 0n, max: 50_000_000n });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('704', '7588', '766', '765'), cents), { maxLength: 6 }),
        fc.array(
          fc.tuple(
            fc.constantFrom('6022', '6051', '611', '6123', '641', '646', '665', '698'),
            cents,
          ),
          { maxLength: 8 },
        ),
        fc.array(fc.tuple(fc.constantFrom('4111', '5311', '4424', '471'), cents), { maxLength: 4 }),
        fc.array(fc.tuple(fc.constantFrom('401', '421', '4315', '4423', '462'), cents), {
          maxLength: 5,
        }),
        (revenues, expenses, assets, debts) => {
          const turnover = [
            ...revenues.map(([account, amount]) => ({ account, debit: 0n, credit: amount })),
            ...expenses.map(([account, amount]) => ({ account, debit: amount, credit: 0n })),
          ];
          const result = turnover.reduce((sum, entry) => sum + entry.credit - entry.debit, 0n);
          const closing: S1005LedgerEntry[] = [
            { account: '1012', debit: 0n, credit: 20_000n },
            {
              account: '121',
              debit: result < 0n ? -result : 0n,
              credit: result > 0n ? result : 0n,
            },
            ...assets.map(([account, amount]) => ({
              account,
              debit: amount,
              credit: 0n,
              ...(account === '471' ? { rows: { F10: '11' as const } } : {}),
            })),
            ...debts.map(([account, amount]) => ({
              account,
              debit: 0n,
              credit: amount,
              rows: current,
            })),
          ];
          const open = closing.reduce((sum, entry) => sum + entry.debit - entry.credit, 0n);
          closing.push({
            account: '5121',
            debit: open < 0n ? -open : 0n,
            credit: open > 0n ? open : 0n,
          });
          const year = s1005FromLedger({ closing, turnover });
          expect(year.issues).toEqual([]);
          const model: S1005 = {
            ...header,
            ...s1005Columns({ current: year }),
            F30: s1005Columns({ current: year }).F30,
            F40: {},
          };
          expect(errors(model)).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('checkS1005', () => {
  const filed = () => completeS1005(servicesStatements());

  test('completion fills the totals, keeps given values and changes nothing twice', () => {
    const model = filed();
    expect(completeS1005(model)).toEqual(model);
    expect(model.F30['93']).toEqual([10_018, 12_950]);
    expect(model.F40['18']).toEqual([6000, 8000, 0, 0, 14_000]);
    expect(model.F40['35']).toEqual([1000, 1500, 0, 2500]);
    // Empty chapters stay empty.
    expect(model.F30['04']).toBeUndefined();
    expect(model.F40['07']).toBeUndefined();
  });

  test('a given total that disagrees is an error under ANAF’s code', () => {
    const model = filed();
    expect(errors({ ...model, F10: { ...model.F10, '49': [73_219, 104_255] } })).toEqual([
      'F10_62',
      'F10_64',
    ]);
    expect(
      errors({
        ...model,
        F20: { ...model.F20, '08': [67_979, 81_036] },
      }),
    ).toEqual(['F20_2', 'F10_F20_3', 'F20_F30_8', 'F10_F30_1']);
    expect(errors({ ...model, F40: { ...model.F40, '10': [0, 8000, 0, 0, 7999] } })).toEqual([
      'F40_14',
      'F40_27',
    ]);
    expect(errors({ ...model, F30: { ...model.F30, '235': [67_979, 81_034] } })).toEqual([
      'F30_148.1',
      'F20_F30_8',
    ]);
  });

  test('sign, exclusion, percentage and "din care" controls', () => {
    const model = filed();
    expect(errors({ ...model, F10: { ...model.F10, '42': [0, 5], '46': undefined } })).toEqual([
      'F10_44',
      'F10_62',
    ]);
    expect(
      errors({
        ...model,
        F10: { ...model.F10, '30': [200, -200], '29': undefined, '46': undefined, '49': undefined },
      }),
    ).toEqual(['F10_22', 'F10_64', 'F10_67']);
    expect(errors({ ...model, F30: { ...model.F30, '147': [200, 100, 200, 100.5] } })).toEqual([
      'F30_98',
    ]);
    expect(errors({ ...model, F20: { ...model.F20, '01a': [120_000, 150_001] } })).toEqual([
      'F20b_cif',
    ]);
    expect(codes({ ...model, F30: { ...model.F30, '69': [0, 10], '70': [0, 20] } })).toEqual([
      'warning:F30_46',
    ]);
  });

  test('values the schema refuses', () => {
    const model = filed();
    expect(
      codes({
        ...model,
        F10: { ...model.F10, '01': [-1, 0], '02': [5000.5, 11_500] },
        F30: { ...model.F30, '161b': [5, 5], '147': [200, 100.123, 200, 100] },
        F40: { ...model.F40, '99': [1] } as S1005['F40'],
      }),
    ).toEqual([
      'error:S1005_AMOUNT',
      'error:S1005_AMOUNT',
      'error:S1005_PERCENT',
      'error:S1005_COLUMN',
      'error:S1005_ROW',
    ]);
    expect(() => writeS1005({ ...model, F10: { ...model.F10, '02': [0.5, 0] } })).toThrow(
      DomainError,
    );
  });

  test('identification data', () => {
    const model = filed();
    expect(errors({ ...model, preparer: { ...model.preparer, cif: undefined } })).toEqual(['R22a']);
    expect(
      errors({ ...model, preparer: { name: 'Ionescu Maria', quality: 12, cif: '14399840' } }),
    ).toEqual(['R22a']);
    expect(
      errors({
        ...model,
        approved: false,
        entity: {
          ...model.entity,
          cui: '18547291',
          county: 41,
          ownership: 99,
          lei: 'ABC',
          caen: '62',
        },
      }),
    ).toEqual([
      'S1005_CUI',
      'S1005_COUNTY',
      'S1005_OWNERSHIP',
      'S1005_CAEN',
      'S1005_LEI',
      'S1005_APPROVED',
    ]);
    expect(errors({ ...model, audit: { kind: 'voluntary' } })).toEqual(['S1005_AUDIT']);
    expect(codes({ ...model, internalAudit: true })).toEqual(['warning:S1005_AUDIT']);
    expect(errors({ ...model, entity: { ...model.entity, name: 'X'.repeat(51) } })).toEqual([
      'S1005_TEXT',
    ]);
  });
});

describe('writeS1005', () => {
  test('writes the identification, every F10 and F20 field, and the F30 and F40 fields given', () => {
    const xml = writeS1005(servicesStatements());
    expect(xml).toStartWith(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Bilant1005 xmlns="mfp:anaf:dgti:s1005:declaratie:v15"',
    );
    expect(xml).toContain(
      'luna="12" an="2025" cui="18547290" den="Exemplu Servicii SRL" adresa="Localitate:Galați,Strada:Str. Lungă,Nr.:10," telefon="0236000000" regCom="J17/123/2010" caen="6210" caenE="6210" bifa_aprob="1" AN_CAEN="2025" bifaMC="0" bifaDD="0" bifaGG="0" bifaAA="0" bifa_art27="0" tipBIL="UU" interes_public="0" codTT="17" codJJ="17" codPP="35" nume_admin="Popescu Ana" nume_intocmit="Ionescu Maria" calit_intocmit="22" nri_intocmit="12345" cif_intocmit="14399840" totalPlata_A="200"',
    );
    expect(xml.match(/F10_\d{4}="/g)).toHaveLength(102);
    expect(xml.match(/F20_\d{4}="/g)).toHaveLength(26);
    expect(xml).toContain('F10_0041="5000" F10_0042="11500"');
    expect(xml).toContain('F30_0011="1" F30_0012="81035" F30_0021="0"');
    expect(xml).toContain('F30_1471="200" F30_1472="100" F30_1473="200" F30_1474="100"');
    expect(xml).not.toContain('F30_0041');
    expect(xml).not.toContain('F40_0071');
    expect(xml).toContain(
      'F40_0181="6000" F40_0182="8000" F40_0183="0" F40_0184="0" F40_0185="14000"',
    );
  });

  test('a large taxpayer files under codJJ 41; the loss-making start-up', () => {
    const xml = writeS1005({
      ...servicesStatements(),
      entity: { ...header.entity, largeTaxpayer: true },
    });
    expect(xml).toContain('bifaMC="1"');
    expect(xml).toContain('codTT="17" codJJ="41"');
    const startup = writeS1005(startupStatements());
    expect(startup).toContain(
      'adresa="Sector:3,Localitate:București,Strada:Str. Fizicienilor,Nr.:7,"',
    );
    expect(startup).toContain('bifaAA="1"');
    expect(startup).toContain('F10_0442="3691"');
    expect(startup).toContain('F10_0462="-2691"');
    expect(startup).toContain('F10_0162="5000"');
    expect(startup).toContain('F20_0092="3691"');
    expect(startup).toContain('F30_0021="1" F30_0022="3691"');
    expect(startup).toContain('<F40/>');
  });

  test('refuses statements checkS1005 finds in error', () => {
    const model = completeS1005(servicesStatements());
    expect(() => writeS1005({ ...model, F20: { ...model.F20, '08': [67_979, 81_036] } })).toThrow(
      'F20_0082 (81036) trebuie să fie 81035',
    );
    expect(() => writeS1005({ ...model, approved: false })).toThrow(DomainError);
  });

  test('the address in the structure’s format', () => {
    expect(
      s1005AddressText({
        sector: 1,
        locality: 'București',
        street: 'Calea Victoriei',
        number: '15',
        block: 'A',
        staircase: '2',
        apartment: '14',
      }),
    ).toBe('Sector:1,Localitate:București,Strada:Calea Victoriei,Nr.:15,Bloc:A,Scara:2,Ap.:14,');
  });
});
