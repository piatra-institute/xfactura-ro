import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateD112, writeD112 } from 'xfactura-core/ro/declarations/d112';
import { readDeclaration } from 'xfactura-core/ro/declarations/read';
import { exportPayrollSources } from '../../../scripts/differential/payroll-sources';
import { inventoryCorpus } from '../src/corpus/inventory';
import { readD112Employees } from '../src/read/d112';
import { readRevisal, revisalNamespace } from '../src/read/revisal';
import {
  d112Model,
  employee,
  otherKey,
  revisalArchive,
  revisalXml,
  sickEmployee,
  syntheticCodes,
  syntheticNames,
  tarMember,
  testKey,
  xmlBytes,
  zipMember,
} from './payroll-fixtures';

const readD112 = (xml: string, key = testKey) =>
  readD112Employees(readDeclaration(xmlBytes(xml)), key);

function expectPrivate(model: unknown) {
  const serialized = JSON.stringify(model);
  for (const text of [
    ...syntheticCodes,
    ...syntheticNames,
    'Societate Sintetica',
    'Adresa Sintetica',
  ])
    expect(serialized).not.toContain(text);
  expect(serialized).not.toContain(testKey.toString('hex'));
}

describe('Revisal snapshots', () => {
  test('reads two contracts for one person, decimal spelling, state dates and unhandled paths', async () => {
    const model = await readRevisal(revisalArchive(), testKey);
    expect(model.employerFiscalCode).toBe('18547290');
    expect(model.exportDate).toBe('2026-10-31T12:00:00.000Z');
    expect(model.exportDateSource).toBe('tar-member-mtime');
    expect(model.contracts).toHaveLength(2);
    const [ended, active] = model.contracts;
    expect(ended!.personKey).toMatch(/^[a-f0-9]{64}$/);
    expect(active!.personKey).toBe(ended!.personKey);
    expect(ended).toMatchObject({
      number: 'C-1',
      date: '2023-09-01T00:00:00',
      type: 'ContractIndividualMunca',
      duration: 'Nedeterminata',
      startDate: '2023-09-04T00:00:00',
      endDate: null,
      occupationCode: '251201',
      recordedAt: '2026-10-01T00:00:00',
      erased: false,
      baseSalary: { amount: '5000.00', currency: null },
      workingTime: {
        type: 'NormaIntreaga',
        duration: '8',
        interval: 'OrePeZi',
        norm: 'NormaIntreaga840',
        distribution: 'OreDeZi',
      },
      state: {
        kind: 'ended',
        sourceType: 'ContractStareIncetare',
        terminationDate: '2026-10-25T00:00:00',
        suspensionEndedAt: '2026-09-19T00:00:00',
      },
    });
    expect(ended!.changes.map((change) => change.kind)).toEqual([
      'suspension',
      'suspension_end',
      'salary',
      'working_time',
      'termination',
    ]);
    expect(ended!.changes[0]).toEqual({
      kind: 'suspension',
      date: '2026-09-10T00:00:00',
      until: '2026-09-20T00:00:00',
      endedAt: '2026-09-19T00:00:00',
    });
    expect(active!.state.kind).toBe('active');
    expect(model.unread).toContainEqual({ path: '/XmlReport/Salariati/Salariat/Nume', count: 1 });
    expect(model.unread).toContainEqual({
      path: '/XmlReport/Salariati/Salariat/Contracte/Contract/Detalii',
      count: 2,
    });
    expect(model.unread).toContainEqual({
      path: '/XmlReport/Salariati/Salariat/Contracte/Contract/Cor/Versiune',
      count: 2,
    });
    expectPrivate(model);
  });

  test('keeps changed salary and working-time observations dated, without inventing past terms', async () => {
    const original = await readRevisal(revisalArchive(), testKey);
    const changedXml = revisalXml('5100.50', '2026-10-20T00:00:00', 'RON').replaceAll(
      '<Durata>8</Durata>',
      '<Durata>4</Durata>',
    );
    const changed = await readRevisal(revisalArchive(changedXml), testKey);
    expect(changed.contracts[0]!.personKey).toBe(original.contracts[0]!.personKey);
    expect(changed.contracts[0]!.changes).toContainEqual({
      kind: 'salary',
      date: '2026-10-20T00:00:00',
      basis: 'DataConsemnare',
      salary: { amount: '5100.50', currency: 'RON' },
    });
    expect(changed.contracts[0]!.changes).toContainEqual({
      kind: 'working_time',
      date: '2026-10-20T00:00:00',
      basis: 'DataConsemnare',
      workingTime: {
        type: 'NormaIntreaga',
        duration: '4',
        interval: 'OrePeZi',
        norm: 'NormaIntreaga840',
        distribution: 'OreDeZi',
      },
    });
    const undated = await readRevisal(
      revisalArchive(
        changedXml.replaceAll(
          '<DataConsemnare>2026-10-20T00:00:00</DataConsemnare>',
          '<DataConsemnare i:nil="true"/>',
        ),
      ),
      testKey,
    );
    expect(undated.contracts[0]!.recordedAt).toBeNull();
    expect(undated.contracts[0]!.changes.at(-1)!.date).toBeNull();
  });

  test('does not promote unknown states, nested fields or audit text into known data', async () => {
    const xml = revisalXml()
      .replace('ContractStareActiv', 'constructor')
      .replace(
        '<AuditEntries i:nil="true"/>',
        `<AuditEntries><Entry><Text>${syntheticNames[0]}</Text></Entry></AuditEntries>`,
      );
    const model = await readRevisal(revisalArchive(xml), testKey);
    expect(model.contracts[1]!.state.kind).toBe('unknown');
    expect(model.unread).toContainEqual({
      path: '/XmlReport/Salariati/Salariat/Contracte/Contract/AuditEntries/Entry/Text',
      count: 1,
    });
    expectPrivate(model);
  });
});

describe('D112 employees', () => {
  test('reads writer figures and employer totals in every month of 2026; absent stays absent', () => {
    for (let month = 1; month <= 12; month++) {
      const input = d112Model(undefined, month);
      const calculation = calculateD112(input);
      const result = readD112(writeD112(input));
      expect(result.layout).toBe('2026-v7');
      expect(result.period?.month).toBe(String(month));
      expect(result.employees).toHaveLength(1);
      expect(result.employees[0]!.figures).toContainEqual({
        section: 'asiguratA',
        occurrence: 1,
        field: 'A_sal1',
        name: 'baseSalary',
        value: '5000',
      });
      expect(result.employees[0]!.figures).toContainEqual({
        section: 'asiguratE3',
        occurrence: 1,
        field: 'E3_8',
        name: 'grossPay',
        value: '5000',
      });
      for (const [field, name, value] of [
        ['A_11', 'cassBase', '5000'],
        ['A_12', 'cass', '500'],
        ['A_13', 'casBase', '5000'],
        ['A_14', 'cas', '1250'],
        ['A_8', 'daysWorked', '22'],
      ])
        expect(result.employees[0]!.figures).toContainEqual({
          section: 'asiguratA',
          occurrence: 1,
          field,
          name,
          value,
        });
      expect(result.employerTotals).toContainEqual({
        section: 'angajatorC4',
        occurrence: 1,
        field: 'C4_ct',
        name: 'employerContribution',
        value: String(calculation.cam.amount),
      });
      expect(
        result.employerClassifications
          .filter((field) => field.field === 'A_codOblig')
          .map((field) => field.value),
      ).toEqual(calculation.obligations.map((obligation) => obligation.code));
      expect(result.employees[0]!.figures.some((field) => field.field === 'E3_10')).toBe(false);
      expect(result.unplacedSections).toEqual([]);
      expectPrivate(result);
    }
  });

  test('reads section B, repeated medical sections, E2, and does not retain certificate identities', () => {
    const base = employee();
    const elsewhere = employee({
      cnp: syntheticCodes[1],
      income: { ...base.income, mainJob: false },
    });
    const input = d112Model([sickEmployee(), elsewhere]);
    const result = readD112(writeD112(input));
    expect(result.employees).toHaveLength(2);
    const figures = result.employees[0]!.figures;
    expect(figures).toContainEqual({
      section: 'asiguratB4',
      occurrence: 1,
      field: 'B4_8',
      name: 'cas',
      value: '1092',
    });
    expect(figures.filter((field) => field.field === 'D_19')).toEqual([
      {
        section: 'asiguratD',
        occurrence: 1,
        field: 'D_19',
        name: 'medicalLeaveDailyAverage',
        value: '283.46',
      },
      {
        section: 'asiguratD',
        occurrence: 2,
        field: 'D_19',
        name: 'medicalLeaveDailyAverage',
        value: '283.46',
      },
    ]);
    expect(result.employees[1]!.figures).toContainEqual({
      section: 'asiguratE2',
      occurrence: 1,
      field: 'E2_4',
      name: 'incomeTax',
      value: '269',
    });
    expect(figures.some((field) => field.field === 'D_2')).toBe(false);
    expectPrivate(result);
    // Other people's identifiers are not numeric payroll figures.
    const withCare = writeD112(input).replace('D_9="01"', `D_8="${syntheticCodes[2]}" D_9="01"`);
    expectPrivate(readD112(withCare));
  });

  test('carries the writer minimum-wage relief and employer contribution differences without calculating them', () => {
    const base = employee();
    const minimum = employee({
      cnp: syntheticCodes[2],
      employment: {
        ...base.employment,
        type: '51',
        baseSalary: 4325,
        unemploymentBase: 4325,
        camBase: 4125,
        cassBase: 4125,
        cass: 413,
        casBase: 4125,
        cas: 1031,
        relief: 200,
      },
      income: {
        ...base.income,
        cash: 4325,
        deduction: { basic: 865, young: 0, children: 0 },
        taxBase: 1816,
        tax: 182,
        paid: 2699,
      },
    });
    const partTime = employee({
      cnp: syntheticCodes[1],
      minimum: { kind: 'due', base: 4325 },
      employment: {
        ...base.employment,
        contract: 'P4',
        hoursWorked: 88,
        baseSalary: 2500,
        unemploymentBase: 2500,
        camBase: 2500,
        cassBase: 2500,
        cass: 250,
        casBase: 2500,
        cas: 625,
      },
      income: {
        ...base.income,
        cash: 2500,
        deduction: { basic: 865, young: 0, children: 0 },
        taxBase: 760,
        tax: 76,
        paid: 1549,
      },
    });
    const model = d112Model([minimum, partTime]);
    const result = readD112(writeD112(model));
    const calculation = calculateD112(model);
    expect(result.employees[0]!.figures).toContainEqual({
      section: 'asiguratA',
      occurrence: 1,
      field: 'A_13S',
      name: 'minimumWageRelief',
      value: '200',
    });
    expect(result.employees[1]!.figures).toContainEqual({
      section: 'asiguratA',
      occurrence: 1,
      field: 'A_14D',
      name: 'employerCasDifference',
      value: String(calculation.insured[1]!.employer.cas),
    });
    expect(result.employees[1]!.figures).toContainEqual({
      section: 'asiguratA',
      occurrence: 1,
      field: 'A_12D',
      name: 'employerCassDifference',
      value: String(calculation.insured[1]!.employer.cass),
    });
    expectPrivate(result);
  });

  test('preserves leading zeroes and decimals, indexes repeated sections and reports unknown fields', () => {
    const xml = writeD112(d112Model())
      .replace('A_sal1="5000"', 'A_sal1="005000.00"')
      .replace('<asiguratE3 ', `<asiguratE3 E3_999="${syntheticCodes[2]}" `)
      .replace(
        '</asigurat>',
        '<asiguratE2 E2_1="12.50"/><asiguratE2 E2_1="13.50"/><asiguratZ unknown="7"/><constructor A_13="1"/></asigurat>',
      );
    const result = readD112(xml);
    expect(result.employees[0]!.figures.find((field) => field.field === 'A_sal1')!.value).toBe(
      '005000.00',
    );
    expect(
      result.employees[0]!.figures.filter((field) => field.field === 'E2_1').map((field) => [
        field.occurrence,
        field.value,
      ]),
    ).toEqual([
      [1, '12.50'],
      [2, '13.50'],
    ]);
    expect(result.unmappedFields).toContainEqual({
      path: 'declaratieUnica/asigurat/asiguratE3/@E3_999',
      count: 1,
    });
    expect(result.unplacedSections).toContainEqual({
      path: 'declaratieUnica/asigurat/asiguratZ',
      count: 1,
    });
    expect(result.unplacedSections).toContainEqual({
      path: 'declaratieUnica/asigurat/constructor',
      count: 1,
    });
    expectPrivate(result);
  });

  test('older namespace reports unplaced sections, carries identity only as a key and never guesses meanings', () => {
    const xml = `<declaratieUnica xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v5" an_r="2016" luna_r="2">
      <angajator cif="18547290"><angajatorC4 C4_ct="12"/></angajator>
      <asigurat cnpAsig="${syntheticCodes[0]}" numeAsig="${syntheticNames[0]}">
        <asiguratA A_13="123.00"/><asiguratVechi X="45"/>
      </asigurat></declaratieUnica>`;
    const result = readD112(xml);
    expect(result.layout).toBe('unsupported');
    expect(result.employees).toHaveLength(1);
    expect(result.employees[0]!.figures).toEqual([]);
    expect(result.employerTotals).toEqual([]);
    expect(result.unplacedSections).toEqual([
      { path: 'declaratieUnica/angajator/angajatorC4', count: 1 },
      { path: 'declaratieUnica/asigurat/asiguratA', count: 1 },
      { path: 'declaratieUnica/asigurat/asiguratVechi', count: 1 },
    ]);
    expectPrivate(result);
  });

  test('both sources use the same keyed identity, and another key changes it in both', async () => {
    const archive = revisalArchive();
    const xml = writeD112(d112Model());
    const first = (await readRevisal(archive, testKey)).contracts[0]!.personKey;
    const second = (await readRevisal(archive, otherKey)).contracts[0]!.personKey;
    expect(first).toBe(readD112(xml).employees[0]!.personKey);
    expect(second).toBe(readD112(xml, otherKey).employees[0]!.personKey);
    expect(second).not.toBe(first);
    expect(() => readD112(xml, Buffer.alloc(0))).toThrow('PAYROLL_KEY_SIZE');
  });

  test('wrong namespaces, missing identities, invalid figures and duplicate field paths fail clearly', () => {
    const xml = writeD112(d112Model());
    expect(() =>
      readD112(xml.replaceAll('mfp:anaf:dgti:declaratie_unica:declaratie:v7', 'urn:other')),
    ).toThrow('D112_NAMESPACE');
    expect(() => readD112(xml.replace(/cnpAsig="[^"]*"/, ''))).toThrow('D112_PERSON_CODE_MISSING');
    expect(() => readD112(xml.replace('A_12="500"', 'A_12="invalid"'))).toThrow('D112_DECIMAL');
    const declaration = readDeclaration(xmlBytes(xml));
    declaration.fields.push(declaration.fields[0]!);
    expect(() => readD112Employees(declaration, testKey)).toThrow('aceeași cale');
  });
});

describe('private payroll export', () => {
  let temporary: string;
  let privateRoot: string;
  let corpus: string;
  let output: string;
  let keyFile: string;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'xfactura-payroll-'));
    privateRoot = join(temporary, '.private');
    corpus = join(privateRoot, 'corpus');
    output = join(privateRoot, 'payroll');
    keyFile = join(privateRoot, 'person.key');
    await mkdir(corpus, { recursive: true });
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  async function prepare(archive = revisalArchive()) {
    await writeFile(join(corpus, 'export.rvs'), archive);
    await writeFile(
      join(corpus, 'return.xml'),
      writeD112(d112Model([employee(), employee({ cnp: syntheticCodes[1] })])),
    );
    await writeFile(
      join(corpus, 'old.xml'),
      writeD112(d112Model()).replace('an_r="2026"', 'an_r="2025"'),
    );
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(await inventoryCorpus(corpus)));
  }

  test('creates a private key and models, uses manifest selection, reports counts only and reruns stably', async () => {
    await prepare();
    const summary = await exportPayrollSources(corpus, output, keyFile);
    expect(summary.exportsRead).toBe(1);
    expect(summary.contracts).toEqual({ total: 2, active: 1, ended: 1, suspended: 0, unknown: 0 });
    expect(summary.d112).toEqual([
      { month: '2026-10', insuredPersons: 2, withContract: 1, withoutContract: 1 },
    ]);
    expect(summary.distinctReturnPersons).toEqual({
      total: 2,
      withContract: 1,
      withoutContract: 1,
    });
    expect((await lstat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await readFile(keyFile)).length).toBe(32);
    const filenames = (await readdir(output)).sort();
    expect(filenames).toHaveLength(4);
    expect(filenames).toContain('coverage.json');
    expect(JSON.parse(await readFile(join(output, 'coverage.json'), 'utf8'))).toMatchObject({
      fieldsOutsideMappingTable: [],
      unplacedSections: [],
      numericFieldsWithoutNeutralName: expect.arrayContaining([
        { path: 'declaratieUnica/asigurat/asiguratE3/@E3_19', count: 2 },
      ]),
    });
    const before = await Promise.all(filenames.map((file) => readFile(join(output, file), 'utf8')));
    for (const text of before) expectPrivate(JSON.parse(text));
    const key = await readFile(keyFile);
    expect(await exportPayrollSources(corpus, output, keyFile)).toEqual(summary);
    expect(await readFile(keyFile)).toEqual(key);
    expect(
      await Promise.all(filenames.map((file) => readFile(join(output, file), 'utf8'))),
    ).toEqual(before);
    expectPrivate(summary);
    expect(JSON.stringify(summary)).not.toContain('personKey');
  });

  const corrupt = () => {
    const archive = revisalArchive();
    archive[0] = archive[0]! ^ 1;
    return archive;
  };
  test.each([
    ['corrupt tar', corrupt, /REVISAL_TAR_CHECKSUM/],
    ['truncated tar', () => revisalArchive().subarray(0, -512), /REVISAL_TAR_TRUNCATED/],
    [
      'tar prefix traversal',
      () =>
        tarMember(zipMember(revisalXml()), 'snapshot.xml.pcs', undefined, undefined, {
          prefix: '../escape',
        }),
      /REVISAL_TAR_PATH/,
    ],
    [
      'nonzero tar trailer',
      () => Buffer.concat([revisalArchive(), Buffer.alloc(512, 1)]),
      /REVISAL_TAR_TRAILER/,
    ],
    [
      'two tar members',
      () =>
        Buffer.concat([
          tarMember(zipMember(revisalXml()), 'one.xml.pcs').subarray(0, -1024),
          tarMember(zipMember(revisalXml()), 'two.xml.pcs'),
        ]),
      /REVISAL_TAR_MEMBERS/,
    ],
    [
      'tar traversal',
      () => tarMember(zipMember(revisalXml()), '../escape.xml.pcs'),
      /REVISAL_TAR_PATH/,
    ],
    [
      'zip traversal',
      () => tarMember(zipMember(revisalXml(), '../escape.xml')),
      /REVISAL_ARCHIVE_(INVALID|PATH)/,
    ],
    [
      'zip bomb',
      () =>
        tarMember(
          zipMember(
            revisalXml().replace(
              '</XmlReport>',
              `<!--${'x'.repeat(2 * 1024 * 1024)}--></XmlReport>`,
            ),
          ),
        ),
      /REVISAL_ARCHIVE_EXPANSION_LIMIT/,
    ],
    [
      'encrypted zip',
      () => tarMember(zipMember(revisalXml(), 'report.xml', true)),
      /REVISAL_ARCHIVE_MEMBER/,
    ],
    [
      'tar symlink',
      () => tarMember(zipMember(revisalXml()), 'snapshot.xml.pcs', undefined, '2'),
      /REVISAL_TAR_MEMBER_TYPE/,
    ],
    [
      'wrong namespace',
      () => revisalArchive(revisalXml().replaceAll(revisalNamespace, 'urn:other')),
      /REVISAL_NAMESPACE/,
    ],
    [
      'foreign child namespace',
      () => revisalArchive(revisalXml().replace('<Salariu>', '<Salariu xmlns="urn:other">')),
      /REVISAL_NAMESPACE/,
    ],
    [
      'XML DTD',
      () =>
        revisalArchive(
          `<!DOCTYPE XmlReport SYSTEM "file:///private"><XmlReport xmlns="${revisalNamespace}"/>`,
        ),
      /REVISAL_XML_DTD/,
    ],
  ])(
    '%s refuses the whole run before writing models or the new key',
    async (_name, makeArchive, error) => {
      await prepare(makeArchive());
      await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(error);
      expect(await readdir(privateRoot)).toEqual(['corpus']);
      expect(await readdir(temporary)).toEqual(['.private']);
    },
  );

  test('public output, traversal and symlink redirects are rejected without writes', async () => {
    await prepare();
    await expect(exportPayrollSources(corpus, join(temporary, 'public'), keyFile)).rejects.toThrow(
      'PAYROLL_OUTPUT_PRIVATE',
    );
    await expect(
      exportPayrollSources(corpus, join(privateRoot, '..', 'public'), keyFile),
    ).rejects.toThrow('PAYROLL_OUTPUT_PRIVATE');
    await symlink(temporary, output);
    await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(
      'PAYROLL_OUTPUT_PATH',
    );
    await rm(output);
    await mkdir(output);
    await symlink(join(corpus, 'return.xml'), join(output, 'summary.json'));
    await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(
      'PAYROLL_UNSAFE_FILE',
    );
    expect(await readdir(privateRoot)).not.toContain('person.key');
  });

  test('a 2026 return without a month refuses the run before writing the key or models', async () => {
    await prepare();
    const path = join(corpus, 'return.xml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('luna_r="10"', ''));
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(await inventoryCorpus(corpus)));
    await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(
      'D112_MONTH_REQUIRED',
    );
    expect(await readdir(privateRoot)).toEqual(['corpus']);
  });

  test('rejects insecure keys, source traversal and changed bytes before creating output', async () => {
    await prepare();
    await writeFile(keyFile, testKey, { mode: 0o644 });
    await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(
      'PAYROLL_KEY_PERMISSIONS_OR_SIZE',
    );
    await chmod(keyFile, 0o600);
    const manifest = JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8'));
    const original = manifest[0].path;
    manifest[0].path = '../outside.rvs';
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(manifest));
    await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(
      'PAYROLL_CORPUS_PATH',
    );
    manifest[0].path = original;
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(manifest));
    const bytes = await readFile(join(corpus, 'export.rvs'));
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(join(corpus, 'export.rvs'), bytes);
    await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(
      'PAYROLL_CORPUS_HASH',
    );
    expect(await readdir(privateRoot)).not.toContain('payroll');
  });

  test('rejects key symlinks and key/output collisions without creating either file', async () => {
    await prepare();
    await writeFile(join(temporary, 'outside.key'), testKey, { mode: 0o600 });
    await symlink(join(temporary, 'outside.key'), keyFile);
    await expect(exportPayrollSources(corpus, output, keyFile)).rejects.toThrow(
      'PAYROLL_UNSAFE_FILE',
    );
    await rm(keyFile);
    for (const path of [
      output,
      join(output, 'person.key'),
      join(output, 'nested', 'person.key'),
      join(output, 'summary.json'),
      join(output, 'summary.json', 'key'),
    ])
      await expect(exportPayrollSources(corpus, output, path)).rejects.toThrow(
        'PAYROLL_KEY_OUTPUT_COLLISION',
      );
    expect(await readdir(privateRoot)).toEqual(['corpus']);
    await expect(
      exportPayrollSources(
        corpus,
        join(privateRoot, 'key-parent', 'output'),
        join(privateRoot, 'key-parent'),
      ),
    ).rejects.toThrow('PAYROLL_KEY_OUTPUT_COLLISION');
    expect(await readdir(privateRoot)).toEqual(['corpus']);
  });

  test('the CLI reports an error code without leaking a personal archive member name', async () => {
    await prepare(
      tarMember(zipMember('<broken>', `${syntheticCodes[0]}-${syntheticNames[0]}.xml`)),
    );
    const run = Bun.spawn(
      [
        process.execPath,
        'scripts/differential/payroll-sources.ts',
        corpus,
        output,
        '--key-file',
        keyFile,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(run.stdout).text();
    const stderr = await new Response(run.stderr).text();
    expect(await run.exited).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('REVISAL_XML_INVALID\n');
    expectPrivate(stderr);
    expect(await readdir(privateRoot)).toEqual(['corpus']);
  });
});
