import { crc32, deflateRawSync } from 'node:zlib';
import type { D112, D112Insured } from 'xfactura-core/ro/declarations/d112';
import { revisalNamespace } from '../src/read/revisal';

// Invented identities; the numerical payroll inputs reuse core/test/d112.test.ts's employee.
export const syntheticCodes = ['1781105170030', '2850722170021', '1900315170013'];
export const syntheticNames = ['NumeSintetic', 'PrenumeSintetic', 'DeclarantSintetic'];
export const testKey = Buffer.alloc(32, 17);
export const otherKey = Buffer.alloc(32, 23);
export const xmlBytes = (text: string) => Buffer.from(text, 'utf8');

export function zipMember(xml: string, path = 'report.xml', encrypted = false): Buffer {
  const bytes = xmlBytes(xml);
  const compressed = deflateRawSync(bytes);
  const name = xmlBytes(path);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(encrypted ? 1 : 0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

export function tarMember(
  contents: Buffer,
  path = 'snapshot.xml.pcs',
  timestamp = '2026-10-31T12:00:00Z',
  type = '0',
  options: { prefix?: string; magic?: 'ustar\0' | 'ustar ' } = {},
): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  const octal = (value: number, start: number, width: number) =>
    header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, start, width, 'ascii');
  octal(0o600, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(contents.length, 124, 12);
  octal(Date.parse(timestamp) / 1000, 136, 12);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(options.magic ?? 'ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (options.prefix) header.write(options.prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([
    header,
    contents,
    Buffer.alloc((512 - (contents.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

export function revisalXml(
  salary = '5000.00',
  recordedAt = '2026-10-01T00:00:00',
  currency = '',
): string {
  const contract = (number: string, state: string) => `<Contract>
    <AuditEntries i:nil="true"/>
    <Cor><Cod>251201</Cod><Versiune>9</Versiune></Cor>
    <DataConsemnare>${recordedAt}</DataConsemnare>
    <DataContract>2023-09-01T00:00:00</DataContract>
    <DataInceputContract>2023-09-04T00:00:00</DataInceputContract>
    <DataSfarsitContract i:nil="true"/>
    <NumarContract>${number}</NumarContract>
    <Salariu>${salary}</Salariu>${currency ? `<Moneda>${currency}</Moneda>` : ''}
    <Radiat>false</Radiat>
    <TimpMunca><Durata>8</Durata><IntervalTimp>OrePeZi</IntervalTimp>
      <Norma>NormaIntreaga840</Norma><Repartizare>OreDeZi</Repartizare></TimpMunca>
    <TipContract>ContractIndividualMunca</TipContract>
    <TipDurata>Nedeterminata</TipDurata><TipNorma>NormaIntreaga</TipNorma>
    ${state}<Detalii>${syntheticNames[0]} ${syntheticCodes[0]}</Detalii>
  </Contract>`;
  return `<XmlReport xmlns="${revisalNamespace}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
    <Header><ClientApplication>Test</ClientApplication><UploadDescription i:nil="true"/>
      <Angajator><Detalii i:type="DetaliiAngajatorPersoanaJuridica">
        <Cui>18547290</Cui><Nume>Societate Sintetica</Nume></Detalii></Angajator></Header>
    <Salariati><Salariat><Cnp>${syntheticCodes[0]}</Cnp><CnpVechi>${syntheticCodes[2]}</CnpVechi>
      <Nume>${syntheticNames[0]}</Nume><Prenume>${syntheticNames[1]}</Prenume>
      <Contracte>${contract(
        'C-1',
        `<StareCurenta i:type="ContractStareIncetare">
        <StarePrecedenta i:type="ContractStareSuspendare"><DataInceput>2026-09-10T00:00:00</DataInceput>
          <DataSfarsit>2026-09-20T00:00:00</DataSfarsit><DataIncetare>2026-09-19T00:00:00</DataIncetare>
        </StarePrecedenta><DataIncetareSuspendare>2026-09-19T00:00:00</DataIncetareSuspendare>
        <DataIncetare>2026-10-25T00:00:00</DataIncetare><TemeiLegal>Test</TemeiLegal>
        <Explicatie>${syntheticNames[1]}</Explicatie></StareCurenta>`,
      )}
      ${contract('C-2', '<StareCurenta i:type="ContractStareActiv"><StarePrecedenta i:nil="true"/></StareCurenta>')}
      </Contracte></Salariat></Salariati></XmlReport>`;
}

export const revisalArchive = (xml = revisalXml()) => tarMember(zipMember(xml));

/** Invented source figures in the layout an accounting program exports; no tax is calculated. */
export function accountingProgramD112(): string {
  return `<declaratieUnica xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v7"
    an_r="2026" luna_r="10" d_rec="0" nume_declar="${syntheticNames[2]}">
    <angajator cif="18547290" den="Societate Sintetica" datCAM="1" totalPlata_A="500">
      <angajatorA A_codOblig="602" A_codBugetar="5503XXXXXX" A_datorat="269"
        A_deductibil="0" A_scutit="0" A_plata="269"/>
      <angajatorB B_cnp="1" B_sanatate="1" B_pensie="1" B_sal="1" B_brutSalarii="5000"/>
      <angajatorC1 C1_11="5000" C1_12="0" C1_21="0" C1_22="0" C1_31="0" C1_32="0"
        C1_T1="5000" C1_T2="0" C1_T3="0" C1_7="0"/>
      <angajatorC2 C2_T6="0" C2_10="0" C2_140="0"/>
      <angajatorC3 C3_11="0" C3_12="0" C3_13="0" C3_14="0" C3_21="0" C3_22="0" C3_23="0"
        C3_24="0" C3_31="0" C3_32="0" C3_33="0" C3_34="0" C3_41="0" C3_42="0" C3_43="0"
        C3_44="0" C3_total="0" C3_suma="0"/>
      <angajatorC4 C4_baza="5000" C4_ct="113"/>
      <angajatorD D2="0" D3="0"/>
      <angajatorE1 E1_venit="0" E1_baza="0"/>
      <angajatorE2 E2_66="0" E2_10="0" E2_140="0"/>
      <angajatorE3 E3_total="0" E3_suma="0"/>
      <angajatorF1 F1_suma="269" F1_deplata="269" F1_suma_ded="0" F1_suma_scut="0"/>
    </angajator>
    <asigurat cnpAsig="${syntheticCodes[0]}" numeAsig="${syntheticNames[0]}" prenAsig="${syntheticNames[1]}"
      idAsig="1" dataAng="01.09.2023" casaSn="GL" asigCI="1" asigSO="1" asigExc="0"
      Timp_E3="269" Tcota_E4="0.00" Tsuma_E4="0">
      <asiguratA A_1="1" A_2="0" A_3="N" A_4="8" A_sal1="5000" A_sal2="0" A_5="5000"
        A_6="176" A_7="0" A_8="22" A_9="5000" A_11="5000" A_12="500" A_13="5000" A_14="1250"
        A_11P="0" A_12P="0" A_13P="0" A_14P="0" A_13S="0" A_13C="0"/>
      <asiguratE1 E1_1="5000" E1_2="1750" E1_3="0" E1_4="562" E1_41="562" E1_42="0"
        E1_421="0" E1_422="0" E1_5="0" E1_6="2688" E1_7="269"/>
      <asiguratE3 E3_1="A" E3_2="1" E3_3="1" E3_4="P" E3_8="5000" E3_9="1750"
        E3_11="0" E3_12="562" E3_121="562" E3_122="0" E3_1221="0" E3_1222="0" E3_13="0"
        E3_14="2688" E3_15="269" E3_16="2981" E3_19="0" E3_52="0" E3_54="0" E3_58="0"
        E3_59="0" E3_60="0" E3_61="0" E3_62="0" E3_64="0" E3_67="0" E3_69="0" E3_71="0" E3_90="0"/>
    </asigurat>
  </declaratieUnica>`;
}

export function employee(patch: Partial<D112Insured> = {}): D112Insured {
  return {
    cnp: syntheticCodes[0]!,
    lastName: syntheticNames[0]!,
    firstName: syntheticNames[1]!,
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
    ...patch,
  };
}

export function d112Model(insured = [employee()], month = 10): D112 {
  return {
    period: { year: 2026, month },
    correction: false,
    declarant: { lastName: syntheticNames[2]!, firstName: syntheticNames[1]!, role: 'Test' },
    employer: {
      cui: '18547290',
      caen: '6201',
      name: 'Societate Sintetica',
      registeredOffice: { address: 'Adresa Sintetica' },
      healthFund: 'RO-GL',
    },
    insured,
  };
}

export function sickEmployee(): D112Insured {
  const base = employee();
  return employee({
    employment: {
      ...base.employment,
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
      ...base.income,
      cash: 4368,
      deduction: { basic: 843, young: 0, children: 0 },
      taxBase: 1996,
      tax: 200,
      paid: 2639,
    },
    sickLeave: [
      {
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
      },
      {
        series: 'CCMAM',
        number: '1002',
        issued: '2026-10-19',
        from: '2026-10-19',
        to: '2026-10-28',
        code: '01',
        place: 'family_doctor',
        diagnosis: '101',
        unpaidDays: 1,
        employerDays: 5,
        fundDays: 2,
        base: { income: 36000, days: 127 },
        percent: '65',
        employer: 921,
        fund: 368,
      },
    ],
  });
}
