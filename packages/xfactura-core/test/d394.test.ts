import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  calculateD394,
  checkD394,
  d394Counties,
  d394InvoiceCounts,
  d394Namespace,
  d394PartnerAbroad,
  d394Rates,
  d394RefundFlags,
  writeD394,
  type D394,
  type D394Operation,
  type D394Partner,
} from '../src/ro/declarations/d394';
import { counties, euVatPrefixes } from '../src/ro/geo';

const registered = (cui: string, name: string): D394Partner => ({ kind: 'registered', cui, name });
const operation = (
  type: D394Operation['type'],
  rate: D394Operation['rate'],
  partner: D394Partner,
  invoices: number,
  base: number,
  vat: number,
): D394Operation => ({ type, rate, partner, invoices, base, vat });

const model = (extra: Partial<D394> = {}): D394 => ({
  period: { year: 2026, month: 9 },
  type: 'L',
  company: {
    cui: '18547290',
    caen: '6201',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați',
    phone: '0236000000',
  },
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Str. Lungă nr. 10' },
  preparer: {
    kind: 'company',
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    capacity: 'Administrator',
  },
  consultation: false,
  affiliates: false,
  operations: [],
  simplified: {},
  series: [],
  issuedInvoices: { own: 0, byBeneficiaries: 0, byThirdParties: 0 },
  invoices: [],
  cashVatDeductible: {},
  ...extra,
});

const issued = {
  series: [
    { type: 'allocated', series: 'XF', first: '1', last: '99999' },
    { type: 'issued', series: 'XF', first: '101', last: '104' },
  ],
  issuedInvoices: { own: 4, byBeneficiaries: 0, byThirdParties: 0 },
} satisfies Partial<D394>;
const monthly = model({
  ...issued,
  operations: [
    operation('L', '21', registered('14399840', 'Client Unu SRL'), 2, 10000, 2100),
    operation('L', '21', registered('13548146', 'Client Doi SRL'), 1, 4000, 840),
    operation('L', '11', registered('10376500', 'Client Trei SRL'), 1, 2000, 220),
    operation('A', '21', registered('16341004', 'Furnizor Unu SRL'), 3, 3000, 630),
  ],
});
const individual = (code?: string): D394Partner =>
  code === undefined
    ? {
        kind: 'unregistered',
        name: 'Georgescu Elena',
        address: { country: 'RO', county: 'RO-GL', locality: 'Galați', street: 'Str. Brăilei' },
      }
    : { kind: 'unregistered', code, name: 'Ionescu Mihai' };

const codes = (value: D394) => checkD394(value).map((check) => `${check.severity}:${check.code}`);
const attribute = (xml: string, name: string, element = 'declaratie394') =>
  new RegExp(`<${element} [^>]*?\\b${name}="([^"]*)"`).exec(xml)?.[1];
const elements = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name} [^>]*/>`, 'g'))].map((match) => match[0]);

describe('D394 namespace and catalogues', () => {
  test('uses v5 from 08/2025 and nothing earlier', () => {
    expect(d394Namespace({ year: 2025, month: 8 })).toBe('mfp:anaf:dgti:d394:declaratie:v5');
    expect(d394Namespace({ year: 2026, month: 12 })).toBe('mfp:anaf:dgti:d394:declaratie:v5');
    expect(() => d394Namespace({ year: 2025, month: 7 })).toThrow('august 2025');
    expect(() => d394Namespace({ year: 2026, month: 0 })).toThrow();
  });

  test('numbers every county as the structure does', () => {
    expect(Object.keys(d394Counties).sort()).toEqual(Object.keys(counties).sort());
    expect(new Set(Object.values(d394Counties)).size).toBe(42);
    expect([d394Counties['RO-GL'], d394Counties['RO-B'], d394Counties['RO-CL']]).toEqual([
      '17',
      '40',
      '51',
    ]);
  });

  test('lists the refund flags once each, with Romanian labels', () => {
    const names = d394RefundFlags.map(([name]) => name);
    expect(names.length).toBe(44);
    expect(new Set(names).size).toBe(44);
    expect(names.slice(-2)).toEqual(['livINecorp', 'efectuat']);
    expect(d394RefundFlags.every(([, label]) => label.length > 0)).toBe(true);
  });
});

describe('D394 calculation', () => {
  test('summarizes by partner type and rate, and by rate', () => {
    const calculation = calculateD394(monthly);
    expect(calculation.operationsReported).toBe(true);
    expect(calculation.partners).toEqual({ registered: 4, unregistered: 0, eu: 0, nonEu: 0 });
    expect(calculation.byPartner.map((summary) => [summary.partnerType, summary.rate])).toEqual([
      [1, '21'],
      [1, '11'],
    ]);
    expect(calculation.byPartner[0]).toMatchObject({
      supplies: { invoices: 3n, base: 14000n, vat: 2940n },
      acquisitions: { invoices: 3n, base: 3000n, vat: 630n },
      cashVatAcquisitions: { invoices: 0n, base: 0n, vat: 0n },
    });
    expect(calculation.byRate.map((summary) => summary.rate)).toEqual(['21', '11']);
    expect(calculation.byRate[1]).toMatchObject({
      supplies: { invoices: 1n, base: 2000n, vat: 220n },
      acquisitions: { invoices: 0n, base: 0n, vat: 0n },
    });
    // 4 partners + bases 14000 + 3000 (21%) + 2000 (11%).
    expect(calculation.controlSum).toBe(19004n);
  });

  test('counts registered partners once and unregistered records each', () => {
    const calculation = calculateD394(
      model({
        ...issued,
        operations: [
          operation('L', '21', registered('14399840', 'Client Unu SRL'), 1, 100, 21),
          operation('L', '11', registered('14399840', 'Client Unu SRL'), 1, 100, 11),
          operation('A', '21', registered('14399840', 'Client Unu SRL'), 1, 100, 21),
          operation('L', '21', individual('1900101400012'), 1, 50, 11),
          operation('L', '21', individual('1900101400012'), 1, 50, 11),
          operation('L', '21', individual(), 1, 50, 11),
        ],
      }),
    );
    expect(calculation.partners).toEqual({ registered: 1, unregistered: 3, eu: 0, nonEu: 0 });
    expect(calculation.byPartner[2]).toEqual({
      partnerType: 2,
      rate: '21',
      supplies: { invoices: 3n, base: 150n, vat: 33n },
    });
    expect(calculation.byRate[0]!.supplies).toEqual({ invoices: 4n, base: 250n, vat: 54n });
    expect(calculation.controlSum).toBe(4n + 250n + 100n + 100n);
  });

  test('keeps acquisitions from suppliers applying VAT on collection apart', () => {
    const { byPartner, byRate, controlSum } = calculateD394(
      model({
        operations: [
          operation('AI', '21', registered('16341004', 'Furnizor Unu SRL'), 2, 1000, 210),
          operation('A', '19', registered('16341004', 'Furnizor Unu SRL'), 1, -100, -19),
        ],
      }),
    );
    expect(byPartner[0]!.cashVatAcquisitions).toEqual({ invoices: 2n, base: 1000n, vat: 210n });
    expect(byRate.map((summary) => summary.rate)).toEqual(['21', '19']);
    expect(byRate[1]!.acquisitions).toEqual({ invoices: 1n, base: -100n, vat: -19n });
    expect(controlSum).toBe(1n + 1000n - 100n);
  });

  test('adds a rate summary for simplified invoices, outside the control sum', () => {
    const { byRate, controlSum, operationsReported } = calculateD394(
      model({ simplified: { '9': { salesWithCode: { base: 100, vat: 9 } }, '21': {} } }),
    );
    expect(operationsReported).toBe(true);
    expect(byRate.map((summary) => summary.rate)).toEqual(['21', '9']);
    expect(byRate[1]!.simplified.salesWithCode).toEqual({ base: 100n, vat: 9n });
    expect(byRate[1]!.simplified.receipts).toEqual({ base: 0n, vat: 0n });
    expect(controlSum).toBe(0n);
  });

  test('reports operations whenever a section is written', () => {
    expect(calculateD394(model()).operationsReported).toBe(false);
    expect(calculateD394(model({ cashVatDeductible: { '21': 42 } })).operationsReported).toBe(
      false,
    );
    expect(calculateD394(model({ series: issued.series })).operationsReported).toBe(true);
    expect(
      calculateD394(model({ invoices: [{ type: 'cancelled', number: '7' }] })).operationsReported,
    ).toBe(true);
  });

  test('agrees between its summaries for any operations', () => {
    const partner = fc.oneof(
      fc.constantFrom('14399840', '13548146', '10376500').map((cui) => registered(cui, 'SRL')),
      fc.constant(individual('1900101400012')),
    );
    const amount = fc.integer({ min: -1_000_000, max: 1_000_000 });
    const operations = fc.array(
      fc
        .record({
          partner,
          type: fc.constantFrom('L', 'A', 'AI'),
          rate: fc.constantFrom(...d394Rates),
          invoices: fc.nat(50),
          base: amount,
          vat: amount,
        })
        .map((value) => ({
          ...value,
          type: value.partner.kind === 'registered' ? value.type : ('L' as const),
        })),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(operations, (list) => {
        const calculation = calculateD394(model({ operations: list }));
        const bases = (pick: 'supplies' | 'acquisitions' | 'cashVatAcquisitions') =>
          calculation.byRate.reduce((sum, summary) => sum + summary[pick].base, 0n);
        expect(calculation.controlSum).toBe(
          BigInt(calculation.partners.registered + calculation.partners.unregistered) +
            bases('supplies') +
            bases('acquisitions') +
            bases('cashVatAcquisitions'),
        );
        for (const summary of calculation.byRate) {
          const parts = calculation.byPartner.filter((part) => part.rate === summary.rate);
          expect(parts.reduce((sum, part) => sum + part.supplies.vat, 0n)).toBe(
            summary.supplies.vat,
          );
          expect(parts.reduce((sum, part) => sum + (part.acquisitions?.base ?? 0n), 0n)).toBe(
            summary.acquisitions.base,
          );
        }
        expect(calculation.byPartner.reduce((sum, part) => sum + part.supplies.invoices, 0n)).toBe(
          list
            .filter((item) => item.type === 'L')
            .reduce((sum, item) => sum + BigInt(item.invoices), 0n),
        );
      }),
      { numRuns: 200 },
    );
  });

  test('refuses inputs it cannot sum', () => {
    const one = (patch: Partial<D394Operation>) =>
      model({
        operations: [{ ...operation('L', '21', registered('14399840', 'A'), 1, 1, 0), ...patch }],
      });
    expect(() => calculateD394(one({ base: 10.5 }))).toThrow('fără zecimale');
    expect(() => calculateD394(one({ vat: 1e15 }))).toThrow('15 cifre');
    expect(() => calculateD394(one({ invoices: -1 }))).toThrow('număr natural');
    expect(() => calculateD394(one({ rate: '0' as '21' }))).toThrow('Cota 0');
    expect(() => calculateD394(one({ type: 'A', partner: individual('1900101400012') }))).toThrow(
      'livrări (L) și achiziții (N)',
    );
    // The special schemes' supplies (LS) are written (V4); their acquisitions under VAT on
    // collection (ASI) are not.
    expect(() => calculateD394(one({ type: 'ASI' as 'L' }))).toThrow('nu este acoperit');
    // N: from an unregistered partner, at rate 0, with its document, the nature for individuals.
    const n = (patch: Partial<D394Operation>) =>
      one({
        type: 'N',
        rate: '0',
        partner: individual('1900101400012'),
        document: 'contract',
        products: [{ code: '35', invoices: 1, base: 1, vat: 0 }],
        ...patch,
      });
    expect(() => calculateD394(n({}))).not.toThrow();
    expect(() => calculateD394(n({ partner: registered('14399840', 'A') }))).toThrow(
      'persoane neînregistrate',
    );
    expect(() => calculateD394(n({ rate: '21' }))).toThrow('Cota 21');
    expect(() => calculateD394(n({ document: undefined }))).toThrow('tipul documentului');
    expect(() => calculateD394(n({ vat: 1 }))).toThrow('nu au TVA');
    expect(() => calculateD394(n({ products: [] }))).toThrow('natura bunurilor');
    expect(() =>
      calculateD394(n({ products: [{ code: '29', invoices: 1, base: 1, vat: 0 }] })),
    ).toThrow('nomenclatorul produselor');
    expect(() =>
      calculateD394(n({ partner: { kind: 'unregistered', code: '6859662', name: 'X SRL' } })),
    ).toThrow('doar pentru achizițiile de la persoane fizice');
    expect(() => calculateD394(one({ document: 'invoice' }))).toThrow('doar pentru achizițiile');
    expect(() => calculateD394(model({ cashVatDeductible: { '21': 0.5 } }))).toThrow(
      'fără zecimale',
    );
    expect(() => calculateD394(model({ period: { year: 2025, month: 7 } }))).toThrow('august 2025');
  });
});

describe('D394 XML', () => {
  test('writes a statement without operations as root and informatii only', () => {
    expect(writeD394(model())).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<declaratie394 xmlns="mfp:anaf:dgti:d394:declaratie:v5"' +
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
        ' xsi:schemaLocation="mfp:anaf:dgti:d394:declaratie:v5 D394.xsd"' +
        ' luna="9" an="2026" tip_D394="L" sistemTVA="0" op_efectuate="0" prsAfiliat="0"' +
        ' cui="18547290" caen="6201" den="Exemplu Servicii SRL" adresa="Str. Lungă nr. 10, Galați"' +
        ' telefon="0236000000" totalPlata_A="0" denR="Popescu Ana" functie_reprez="Administrator"' +
        ' adresaR="Str. Lungă nr. 10" tip_intocmit="0" den_intocmit="Exemplu Servicii SRL"' +
        ' cif_intocmit="18547290" calitate_intocmit="Administrator" optiune="0">\n' +
        '  <informatii nrCui1="0" nrCui2="0" nrCui3="0" nrCui4="0" nr_BF_i1="0" incasari_i1="0"' +
        ' incasari_i2="0" nrFacturi_terti="0" nrFacturi_benef="0" nrFacturi="0" tvaDedAI21="0"' +
        ' tvaDedAI11="0" tvaDedAI20="0" tvaDedAI19="0" tvaDedAI9="0" tvaDedAI5="0" solicit="0"/>\n' +
        '</declaratie394>\n',
    );
  });

  test('writes the sections in the validator order with computed summaries', () => {
    const xml = writeD394(monthly);
    const order = [...xml.matchAll(/<(\w+)[ >]/g)].map((match) => match[1]);
    expect(order).toEqual([
      'declaratie394',
      'informatii',
      'rezumat1',
      'rezumat1',
      'rezumat2',
      'rezumat2',
      'serieFacturi',
      'serieFacturi',
      'op1',
      'op1',
      'op1',
      'op1',
    ]);
    expect(attribute(xml, 'op_efectuate')).toBe('1');
    expect(attribute(xml, 'totalPlata_A')).toBe('19004');
    expect(attribute(xml, 'nrCui1', 'informatii')).toBe('4');
    expect(attribute(xml, 'nrFacturi', 'informatii')).toBe('4');
    expect(elements(xml, 'rezumat1')[1]).toBe(
      '<rezumat1 tip_partener="1" cota="11" facturiL="1" bazaL="2000" tvaL="220" facturiA="0"' +
        ' bazaA="0" tvaA="0" facturiAI="0" bazaAI="0" tvaAI="0" facturiC="0" bazaC="0" tvaC="0"/>',
    );
    expect(elements(xml, 'rezumat2')[0]).toBe(
      '<rezumat2 cota="21" bazaFSLcod="0" TVAFSLcod="0" bazaFSL="0" TVAFSL="0" bazaFSA="0"' +
        ' TVAFSA="0" bazaFSAI="0" TVAFSAI="0" bazaBFAI="0" TVABFAI="0" nrFacturiL="3"' +
        ' bazaL="14000" tvaL="2940" nrFacturiA="3" bazaA="3000" tvaA="630" nrFacturiAI="0"' +
        ' bazaAI="0" tvaAI="0" baza_incasari_i1="0" tva_incasari_i1="0" baza_incasari_i2="0"' +
        ' tva_incasari_i2="0"/>',
    );
    expect(elements(xml, 'serieFacturi')).toEqual([
      '<serieFacturi tip="1" serieI="XF" nrI="1" nrF="99999"/>',
      '<serieFacturi tip="2" serieI="XF" nrI="101" nrF="104"/>',
    ]);
    expect(elements(xml, 'op1')[3]).toBe(
      '<op1 tip="A" tip_partener="1" cota="21" cuiP="16341004" denP="Furnizor Unu SRL"' +
        ' nrFact="3" baza="3000" tva="630"/>',
    );
  });

  test('writes partners established abroad as types 3 and 4, with C for the VAT owed', () => {
    const outside = d394PartnerAbroad('US', '94-1234567', 'Example Inc.', euVatPrefixes)!;
    const german = d394PartnerAbroad('DE', '123456789', 'Beispiel GmbH', euVatPrefixes)!;
    expect([outside, german]).toEqual([
      { kind: 'nonEstablished', region: 'nonEu', code: '94-1234567', name: 'Example Inc.' },
      { kind: 'nonEstablished', region: 'eu', code: 'DE123456789', name: 'Beispiel GmbH' },
    ]);
    // Without a code the partner is declared as not registered, by its address; Romania is not
    // abroad.
    expect(d394PartnerAbroad('FR', ' ', 'Dupont', euVatPrefixes)).toBeNull();
    expect(d394PartnerAbroad('RO', '14399840', 'Client Unu SRL', euVatPrefixes)).toBeNull();
    const statement = model({
      ...issued,
      operations: [
        operation('L', '21', registered('14399840', 'Client Unu SRL'), 2, 1000, 210),
        operation('L', '21', german, 1, 400, 84),
        operation('C', '21', outside, 1, 500, 105),
      ],
    });
    expect(checkD394(statement)).toEqual([]);
    const calculation = calculateD394(statement);
    expect(calculation.partners).toEqual({ registered: 1, unregistered: 0, eu: 1, nonEu: 1 });
    // nrCui1–4 and rezumat2's bazaL (1000 + 400) and bazaA (C: 500).
    expect(calculation.controlSum).toBe(3n + 1400n + 500n);
    const xml = writeD394(statement);
    expect([
      attribute(xml, 'nrCui3', 'informatii'),
      attribute(xml, 'nrCui4', 'informatii'),
    ]).toEqual(['1', '1']);
    expect(elements(xml, 'rezumat1').slice(1)).toEqual([
      '<rezumat1 tip_partener="3" cota="21" facturiL="1" bazaL="400" tvaL="84" facturiC="0"' +
        ' bazaC="0" tvaC="0"/>',
      '<rezumat1 tip_partener="4" cota="21" facturiL="0" bazaL="0" tvaL="0" facturiC="1"' +
        ' bazaC="500" tvaC="105"/>',
    ]);
    expect(elements(xml, 'op1').slice(1)).toEqual([
      '<op1 tip="L" tip_partener="3" cota="21" cuiP="DE123456789" denP="Beispiel GmbH"' +
        ' nrFact="1" baza="400" tva="84"/>',
      '<op1 tip="C" tip_partener="4" cota="21" cuiP="94-1234567" denP="Example Inc."' +
        ' nrFact="1" baza="500" tva="105"/>',
    ]);
    // Only L and C, without products, and each code once per type and rate.
    const refused = model({
      ...issued,
      operations: [
        operation('A', '21', outside, 1, 500, 105),
        {
          ...operation('C', '21', german, 1, 500, 105),
          products: [{ code: '22', invoices: 1, base: 500, vat: 105 }],
        },
        operation('L', '21', german, 1, 400, 84),
        operation('L', '21', german, 1, 400, 84),
      ],
    });
    expect(checkD394(refused).map((check) => check.code)).toEqual([
      'D394_OPERATION',
      'D394_PRODUCTS',
      'D394_DUPLICATE',
    ]);
  });

  test('counts an invoice with several rates once, for the largest VAT, the highest rate on a tie', () => {
    const counts = d394InvoiceCounts([
      // F1: 100 lei VAT at 21% and 110 lei at 11%; F2: 21 lei at 21% and 21 lei at 11%; F3 only
      // at 21%; a credit note counts by the size of its VAT.
      {
        key: 'L21',
        rate: '21',
        documents: new Map([
          ['F1', 10000n],
          ['F2', 2100n],
          ['F3', 1n],
        ]),
      },
      {
        key: 'L11',
        rate: '11',
        documents: new Map([
          ['F1', 11000n],
          ['F2', 2100n],
        ]),
      },
      { key: 'L9', rate: '9', documents: new Map([['N1', -900n]]) },
      { key: 'L5', rate: '5', documents: new Map([['N1', 500n]]) },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ L21: 2, L11: 1, L9: 1, L5: 0 });
  });

  test('writes individuals by code or by address', () => {
    const xml = writeD394(
      model({
        ...issued,
        operations: [
          operation('L', '21', individual('1900101400012'), 1, 500, 105),
          operation('L', '21', individual(), 1, 300, 63),
        ],
      }),
    );
    expect(elements(xml, 'rezumat1')).toEqual([
      '<rezumat1 tip_partener="2" cota="21" facturiL="2" bazaL="800" tvaL="168"/>',
    ]);
    expect(elements(xml, 'op1')).toEqual([
      '<op1 tip="L" tip_partener="2" cota="21" cuiP="1900101400012" denP="Ionescu Mihai"' +
        ' nrFact="1" baza="500" tva="105"/>',
      '<op1 tip="L" tip_partener="2" cota="21" denP="Georgescu Elena" taraP="RO" locP="Galați"' +
        ' judP="17" strP="Str. Brăilei" nrFact="1" baza="300" tva="63"/>',
    ]);
    expect(attribute(xml, 'nrCui2', 'informatii')).toBe('2');
  });

  test('writes acquisitions from unregistered persons (N) by document type, with their nature', () => {
    const xml = writeD394(
      model({
        operations: [
          {
            ...operation(
              'N',
              '0',
              { kind: 'unregistered', code: '6859662', name: 'X SRL' },
              2,
              900,
              0,
            ),
            document: 'invoice',
          },
          {
            ...operation('N', '0', individual('1900101400012'), 1, 2500, 0),
            document: 'contract',
            products: [{ code: '35', invoices: 1, base: 2500, vat: 0 }],
          },
          {
            ...operation('N', '0', individual(), 1, 4000, 0),
            document: 'purchaseSlip',
            products: [
              { code: '1001', invoices: 1, base: 3000, vat: 0 },
              { code: '1003', invoices: 0, base: 1000, vat: 0 },
            ],
          },
        ],
      }),
    );
    const flat = xml.replace(/>\s+</g, '><');
    expect(
      [...flat.matchAll(/<rezumat1 [^>]*?(\/>|>.*?<\/rezumat1>)/g)].map((match) => match[0]),
    ).toEqual([
      '<rezumat1 tip_partener="2" cota="0" facturiLS="0" bazaLS="0" facturiN="2" document_N="1" bazaN="900"/>',
      '<rezumat1 tip_partener="2" cota="0" facturiN="1" document_N="2" bazaN="4000">' +
        '<detaliu bun="21" nrN="1" valN="4000"/></rezumat1>',
      '<rezumat1 tip_partener="2" cota="0" facturiN="1" document_N="4" bazaN="2500">' +
        '<detaliu bun="35" nrN="1" valN="2500"/></rezumat1>',
    ]);
    expect(xml).toContain(
      '<op1 tip="N" tip_partener="2" cota="0" cuiP="6859662" denP="X SRL" tip_document="1"' +
        ' nrFact="2" baza="900"/>',
    );
    expect(flat).toContain(
      '<op1 tip="N" tip_partener="2" cota="0" cuiP="1900101400012" denP="Ionescu Mihai"' +
        ' tip_document="4" nrFact="1" baza="2500"><op11 nrFactPR="1" codPR="35" bazaPR="2500"/></op1>',
    );
    // No rezumat2 for rate 0; each record counts in nrCui2; N is outside the control sum.
    expect(xml).not.toContain('<rezumat2');
    expect(attribute(xml, 'nrCui2', 'informatii')).toBe('3');
    expect(attribute(xml, 'totalPlata_A')).toBe('3');
  });

  test('writes the refund flags only with a refund', () => {
    const refund = Object.fromEntries(
      d394RefundFlags.map(([name]) => [name, name === 'Prest21' || name === 'efectuat']),
    ) as NonNullable<D394['refund']>;
    const xml = writeD394(model({ refund }));
    expect(attribute(xml, 'solicit', 'informatii')).toBe('1');
    expect(attribute(xml, 'Prest21', 'informatii')).toBe('1');
    expect(attribute(xml, 'achizitiiPE', 'informatii')).toBe('0');
    const informatii = elements(xml, 'informatii')[0]!;
    expect(informatii.indexOf(' solicit=')).toBeLessThan(informatii.indexOf(' achizitiiPE='));
    expect(informatii.endsWith('livINecorp="0" efectuat="1"/>')).toBe(true);
    expect(attribute(writeD394(model()), 'achizitiiPE', 'informatii')).toBeUndefined();
  });

  test('writes the deductible VAT on payment, 24% only when given', () => {
    const xml = writeD394(model({ cashVatDeductible: { '21': 210, '19': 38 } }));
    expect(attribute(xml, 'tvaDedAI21', 'informatii')).toBe('210');
    expect(attribute(xml, 'tvaDedAI19', 'informatii')).toBe('38');
    expect(attribute(xml, 'tvaDedAI11', 'informatii')).toBe('0');
    expect(attribute(xml, 'tvaDedAI24', 'informatii')).toBeUndefined();
    const legacy = writeD394(model({ cashVatDeductible: { '24': 5 } }));
    expect(attribute(legacy, 'tvaDedAI24', 'informatii')).toBe('5');
  });

  test('writes VAT on collection: sistemTVA 1, tvaCol and tvaDed at every rate', () => {
    const xml = writeD394(
      model({
        cashVatDeductible: { '21': 42 },
        vatOnCollection: { collected: { '21': 87, '11': 5 }, deductible: { '21': 21 } },
      }),
    );
    expect(attribute(xml, 'sistemTVA')).toBe('1');
    expect(attribute(xml, 'tvaCol21', 'informatii')).toBe('87');
    expect(attribute(xml, 'tvaCol11', 'informatii')).toBe('5');
    expect(attribute(xml, 'tvaCol24', 'informatii')).toBe('0');
    expect(attribute(xml, 'tvaDed21', 'informatii')).toBe('21');
    expect(attribute(xml, 'tvaDed24', 'informatii')).toBe('0');
    expect(attribute(xml, 'tvaDedAI21', 'informatii')).toBe('42');
    expect(attribute(xml, 'tvaDedAI24', 'informatii')).toBeUndefined();
    const normal = writeD394(model());
    expect(attribute(normal, 'sistemTVA')).toBe('0');
    expect(attribute(normal, 'tvaCol21', 'informatii')).toBeUndefined();
    expect(attribute(normal, 'tvaDed21', 'informatii')).toBeUndefined();
    expect(() =>
      calculateD394(model({ vatOnCollection: { collected: { '21': 0.5 }, deductible: {} } })),
    ).toThrow('TVA colectată');
  });

  test('writes listed invoices, with amounts only for self-invoices', () => {
    const xml = writeD394(
      model({
        invoices: [
          { type: 'storno', series: 'XF', number: '105' },
          { type: 'onBehalf', number: '9' },
          {
            type: 'selfInvoice',
            series: 'XF',
            number: '107',
            amounts: { '21': { base: 100, vat: 21 }, '11': { base: -10, vat: -1 } },
          },
        ],
      }),
    );
    expect(elements(xml, 'facturi')).toEqual([
      '<facturi tip_factura="1" serie="XF" nr="105"/>',
      '<facturi tip_factura="4" nr="9"/>',
      '<facturi tip_factura="3" serie="XF" nr="107" baza21="100" baza11="-10" baza20="0"' +
        ' baza19="0" baza9="0" baza5="0" tva5="0" tva9="0" tva19="0" tva20="0" tva21="21"' +
        ' tva11="-1"/>',
    ]);
  });

  test('writes the identification options and escapes text', () => {
    const xml = writeD394(
      model({
        type: 'T',
        company: {
          ...model().company,
          name: 'Exemplu & "Fiul" SRL',
          fax: '0236000001',
          email: 'office@exemplu.ro',
        },
        representative: {
          cif: '1900101400012',
          name: 'Popescu Ana',
          role: 'Împuternicit',
          address: 'Str. Lungă nr. 10',
          email: 'ana@exemplu.ro',
        },
        preparer: {
          kind: 'individual',
          cnp: '2900101400022',
          name: 'Ionescu Maria',
          position: 'Contabil',
        },
        consultation: true,
        consultationChanged: true,
        affiliates: true,
        series: [
          {
            type: 'thirdParty',
            series: 'TP',
            first: '1',
            issuer: { name: 'Terț SRL', cui: '13548146' },
          },
        ],
      }),
    );
    expect(attribute(xml, 'den')).toBe('Exemplu &amp; &quot;Fiul&quot; SRL');
    expect(attribute(xml, 'tip_D394')).toBe('T');
    expect(attribute(xml, 'cifR')).toBe('1900101400012');
    expect(attribute(xml, 'functie_reprez')).toBe('Împuternicit');
    expect(attribute(xml, 'tip_intocmit')).toBe('1');
    expect(attribute(xml, 'cif_intocmit')).toBe('2900101400022');
    expect(attribute(xml, 'calitate_intocmit')).toBeUndefined();
    expect(attribute(xml, 'functie_intocmit')).toBe('Contabil');
    expect([attribute(xml, 'optiune'), attribute(xml, 'schimb_optiune')]).toEqual(['1', '1']);
    expect(attribute(xml, 'prsAfiliat')).toBe('1');
    expect(elements(xml, 'serieFacturi')).toEqual([
      '<serieFacturi tip="4" serieI="TP" nrI="1" den="Terț SRL" cui="13548146"/>',
    ]);
  });

  test('refuses an unknown county and is deterministic', () => {
    const unknown = model({
      operations: [
        operation(
          'L',
          '21',
          { kind: 'unregistered', name: 'X', address: { country: 'RO', county: 'RO-XX' } },
          1,
          1,
          0,
        ),
      ],
    });
    expect(() => writeD394(unknown)).toThrow('RO-XX');
    expect(writeD394(monthly)).toBe(writeD394(structuredClone(monthly)));
  });
});

describe('D394 checks', () => {
  test('pass for consistent statements', () => {
    expect(checkD394(monthly)).toEqual([]);
    expect(checkD394(model())).toEqual([]);
    expect(checkD394(model({ ...monthly, type: 'T', period: { year: 2026, month: 6 } }))).toEqual(
      [],
    );
  });

  test('match the statement type to the month', () => {
    expect(codes(model({ type: 'T', period: { year: 2026, month: 7 } }))).toEqual([
      'error:D394_TYPE_MONTH',
    ]);
    for (const month of [2, 3, 5, 6, 8, 9, 11, 12])
      expect(checkD394(model({ type: 'T', period: { year: 2026, month } }))).toEqual([]);
    expect(codes(model({ type: 'S', period: { year: 2026, month: 9 } }))).toEqual([
      'error:D394_TYPE_MONTH',
    ]);
    expect(codes(model({ type: 'A', period: { year: 2026, month: 11 } }))).toEqual([
      'error:D394_TYPE_MONTH',
    ]);
    expect(codes(model({ period: { year: 2025, month: 7 } }))).toEqual(['error:D394_PERIOD']);
  });

  test('check the identification fields', () => {
    const checks = checkD394(
      model({
        company: {
          ...model().company,
          cui: 'RO18547290',
          caen: '62',
          name: ' ',
          phone: '',
          email: 'x'.repeat(201),
        },
        representative: { cif: '1900101400013', name: 'Popescu Ana', role: '', address: 'X' },
        preparer: { kind: 'company', cui: '18547291', name: 'A'.repeat(76), capacity: ' ' },
      }),
    );
    expect(checks.map((check) => `${check.code}:${check.path}`)).toEqual([
      'D394_CUI:company.cui',
      'D394_CAEN:company.caen',
      'D394_TEXT:company.name',
      'D394_TEXT:company.phone',
      'D394_TEXT:company.email',
      'D394_CUI:representative.cif',
      'D394_TEXT:representative.role',
      'D394_TEXT:preparer.name',
      'D394_CUI:preparer.cui',
      'D394_PREPARER:preparer.capacity',
    ]);
    expect(checks.every((check) => check.severity === 'error')).toBe(true);
    expect(
      codes(model({ representative: { ...model().representative, cif: '14399840' } })),
    ).toEqual([]);
  });

  test('require an individual preparer to give a capacity or a position', () => {
    const preparer = { kind: 'individual', cnp: '2900101400022', name: 'Ionescu Maria' } as const;
    expect(codes(model({ preparer }))).toEqual(['error:D394_PREPARER']);
    expect(codes(model({ preparer: { ...preparer, capacity: 'Expert contabil' } }))).toEqual([]);
    expect(
      codes(model({ preparer: { ...preparer, cnp: '2900101400023', position: 'C' } })),
    ).toEqual(['error:D394_CUI']);
    expect(codes(model({ consultationChanged: true }))).toEqual(['error:D394_CONSULTATION']);
  });

  test('check partner codes, duplicates and addresses', () => {
    const sales = (...operations: D394Operation[]) => model({ ...issued, operations });
    expect(
      codes(sales(operation('L', '21', registered('RO14399840', 'Client'), 1, 100, 21))),
    ).toEqual(['error:D394_PARTNER']);
    expect(
      codes(
        sales(
          operation('L', '21', registered('14399840', 'Client'), 1, 100, 21),
          operation('L', '21', registered('14399840', 'Client'), 1, 100, 21),
          operation('L', '11', registered('14399840', 'Client'), 1, 100, 11),
          operation('A', '21', registered('14399840', 'Client'), 1, 100, 21),
        ),
      ),
    ).toEqual(['error:D394_DUPLICATE']);
    expect(codes(sales(operation('L', '21', individual('1900101400013'), 1, 100, 21)))).toEqual([
      'error:D394_PARTNER',
    ]);
    expect(codes(sales(operation('L', '21', individual('14399840'), 1, 100, 21)))).toEqual([]);
    const address = (value?: Extract<D394Partner, { kind: 'unregistered' }>['address']) =>
      codes(
        sales(operation('L', '21', { kind: 'unregistered', name: 'X', address: value }, 1, 0, 0)),
      );
    expect(address(undefined)).toEqual(['error:D394_ADDRESS']);
    expect(address({ country: 'RO' })).toEqual(['error:D394_ADDRESS']);
    expect(address({ country: 'DE', county: 'RO-GL' })).toEqual(['error:D394_ADDRESS']);
    expect(address({ country: 'RO', county: 'RO-XX' })).toEqual(['error:D394_ADDRESS']);
    expect(address({ country: 'de' })).toEqual(['error:D394_ADDRESS']);
    expect(address({ country: 'DE', locality: 'Berlin' })).toEqual([]);
    const coded: D394Partner = {
      kind: 'unregistered',
      code: '1900101400012',
      name: 'Ionescu Mihai',
      address: { country: 'RO', county: 'RO-B' },
    };
    expect(codes(sales(operation('L', '21', coded, 1, 0, 0)))).toEqual(['error:D394_ADDRESS']);
  });

  test('report what calculateD394 refuses, path by path', () => {
    const checks = checkD394(
      model({
        ...issued,
        operations: [
          operation('A', '21', individual('1900101400012'), 1.5, 100, 21),
          operation('L', '0' as '21', registered('14399840', 'Client'), 1, 100, 0),
        ],
        simplified: { '21': { receipts: { base: 0.5, vat: 0 } } },
      }),
    );
    expect(checks.map((check) => `${check.code}:${check.path}`)).toEqual([
      'D394_OPERATION:operations.0.type',
      'D394_AMOUNT:operations.0.invoices',
      'D394_RATE:operations.1.rate',
      'D394_AMOUNT:simplified.21.receipts.base',
    ]);
  });

  test('tie the invoice counts to the series', () => {
    expect(
      codes(model({ ...issued, issuedInvoices: { ...issued.issuedInvoices, own: 0 } })),
    ).toEqual(['error:D394_SERIES']);
    expect(
      codes(model({ issuedInvoices: { own: 3, byBeneficiaries: 0, byThirdParties: 0 } })),
    ).toEqual(['error:D394_SERIES']);
    expect(codes(model({ ...issued, series: [issued.series[1]] }))).toEqual(['error:D394_SERIES']);
    expect(
      codes(
        model({
          operations: monthly.operations.slice(0, 1),
          issuedInvoices: issued.issuedInvoices,
        }),
      ),
    ).toEqual(['error:D394_SERIES']);
    expect(codes(model({ operations: monthly.operations.slice(0, 1) }))).toEqual([
      'error:D394_SERIES',
    ]);
    expect(codes(model({ operations: monthly.operations.slice(3) }))).toEqual([]);
    expect(
      codes(
        model({
          series: [
            {
              type: 'beneficiary',
              first: '1',
              issuer: { name: 'Beneficiar SRL', cui: '14399841' },
            },
          ],
          issuedInvoices: { own: 0, byBeneficiaries: 1, byThirdParties: 0 },
        }),
      ),
    ).toEqual(['error:D394_CUI']);
  });

  test('refuse affiliates without operations', () => {
    expect(codes(model({ affiliates: true }))).toEqual(['error:D394_AFFILIATES']);
    expect(codes(model({ ...monthly, affiliates: true }))).toEqual([]);
  });

  test('warn when VAT strays more than 5 lei from the rate, in integer arithmetic', () => {
    const vat = (base: number, tax: number, rate: D394Operation['rate'] = '21') =>
      codes(
        model({ operations: [operation('A', rate, registered('16341004', 'F'), 1, base, tax)] }),
      );
    expect(vat(1000, 205)).toEqual([]);
    expect(vat(1000, 215)).toEqual([]);
    expect(vat(1000, 204)).toEqual(['warning:D394_VAT']);
    expect(vat(1000, 216)).toEqual(['warning:D394_VAT']);
    // 199 × 11 / 100 truncates to 21.
    expect(vat(199, 16, '11')).toEqual([]);
    expect(vat(199, 15, '11')).toEqual(['warning:D394_VAT']);
    expect(vat(-1000, -210)).toEqual([]);
    expect(vat(-1000, -204)).toEqual(['warning:D394_VAT']);
  });

  test('report totals beyond 15 digits', () => {
    const huge = operation('A', '21', registered('16341004', 'F'), 1, 999_999_999_999_999, 0);
    const checks = codes(
      model({ operations: [huge, { ...huge, partner: registered('14399840', 'G') }] }),
    );
    expect(checks).toContain('error:D394_TOTAL');
  });
});
