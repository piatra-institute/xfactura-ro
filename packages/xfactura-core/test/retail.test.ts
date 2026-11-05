import { describe, expect, test } from 'bun:test';
import {
  turnoverKey,
  validateEffect,
  type AccountInfo,
  type AccountTurnover,
  type DocumentRecord,
  type Loaded,
  type ProfileFact,
} from '../src/kernel';
import { writeD394, calculateD394, checkD394, type D394 } from '../src/ro/declarations/d394';
import { isValidCnp } from '../src/ro/identifiers';
import { roRegister } from '../src/ro/register';
import {
  amefXmlBytes,
  b2cInvoice,
  includedVat,
  parseA4203,
  receiptInvoiceInput,
  receiptInvoiceRecognition,
  retailCount,
  retailCountInput,
  retailDischarge,
  retailDischargeInput,
  zReportBookingInput,
  zReportDocumentSchema,
  zReportProblems,
  zReportRecognition,
  type ZReportDocument,
} from '../src/ro/retail';
import { reviewSpecs } from '../src/ro/reviews';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

// Amounts by hand. A day of a register: 121,00 lei at 21% (VAT 21,00) and 22,20 at 11% (VAT
// 2,20), paid 43,20 in cash and 100,00 by card. A warehouse at retail price: goods received at
// 1.815,00 with VAT (VAT included 315,00, markup 500,00, cost 1.000,00), 605,00 sold: the
// coefficient 500 ÷ (1.815 − 315) = 33,33%, the markup discharged 500 × 1/3 = 166,67, the VAT
// 105,00, so 607 keeps 605 − 166,67 − 105 = 333,33, the cost of a third of the goods.

const rules = () => new RuleContext(roRegister(), 'preview');
const REPORT = '00000000-0000-4000-8000-00000000f001';
const STORE = '00000000-0000-4000-8000-00000000f002';
const INVOICE = '00000000-0000-4000-8000-00000000f003';
const BUYER = '00000000-0000-4000-8000-00000000f004';
const facts = (extra: [string, string][]): ProfileFact[] =>
  [['vat.status', 'normal_vat'], ['vat.period', 'monthly'], ...extra].map(([axis, value]) => ({
    axis: axis!,
    value: value!,
    effectiveFrom: '2026-01-01' as LocalDate,
  }));

const day = (overrides: Partial<ZReportDocument> = {}): ZReportDocument =>
  zReportDocumentSchema.parse({
    parserVersion: 'extracted-zreport-1',
    seller: { name: 'Magazin Exemplu SRL', taxId: 'RO18547290', country: 'RO' },
    register: '4400012345',
    number: '7',
    issueDate: '2026-10-22',
    time: '21:00:00',
    receipts: 5,
    currency: 'RON',
    taxes: [
      { rate: '21', gross: '121.00', tax: '21.00' },
      { rate: '11', gross: '22.20', tax: '2.20' },
    ],
    exempt: '0.00',
    otherTaxes: '0.00',
    totals: { gross: '143.20', tax: '23.20' },
    buyerCode: null,
    cancellations: null,
    discounts: null,
    surcharges: null,
    serviceSums: null,
    payments: [
      { method: 'cash', amount: '43.20', currency: 'RON' },
      { method: 'card', amount: '100.00', currency: 'RON' },
    ],
    journalId: null,
    cumulative: null,
    failures: null,
    items: [],
    ...overrides,
  });
const record = (body: ZReportDocument): DocumentRecord => ({
  id: REPORT,
  kind: 'zreport',
  schema: body.parserVersion,
  body: body as never,
  bodyHash: 'z',
  docDate: body.issueDate as LocalDate,
  partyId: null,
  currency: 'RON',
  number: body.number,
  evidenceId: null,
});
const lines = (effect: { lines: { side: string; account: string; bani: bigint }[] } | null) =>
  effect?.lines.map(
    (line) => `${line.side} ${line.account} ${(Number(line.bani) / 100).toFixed(2)}`,
  );

describe('the Z report', () => {
  test("adds up: rates, payments and VAT; a wrong total is the report's problem", () => {
    expect(zReportProblems(day())).toEqual([]);
    expect(zReportProblems(day({ totals: { gross: '143.00', tax: '23.20' } }))).toHaveLength(2);
    expect(
      zReportProblems(
        day({
          taxes: [
            { rate: '21', gross: '121.00', tax: '20.00' },
            { rate: '11', gross: '22.20', tax: '2.20' },
          ],
          totals: { gross: '143.20', tax: '22.20' },
        }),
      ),
    ).toEqual(['La cota 21%, 121.00 lei cu TVA includ 21.00 lei TVA, nu 20.00.']);
    expect(includedVat(12_100n, '21')).toBe(2_100n);
    expect(includedVat(3_000n, '21')).toBe(521n);
  });

  const a4203 = `<?xml version="1.0" encoding="UTF-8"?>
<msj xmlns="mfp:anaf:dgti:a4203:declaratie:v1" idM="4400012345202610222110000007" cif="18547290">
<bon idB="44000123452026102209150000070001" totB="143.20" totTva="23.20"><cote cota="21" tva="21.00"/><cote cota="11" tva="2.20"/></bon>
<rB idR="4400012345202610222105000007" nrAv="0" nrB="5" totB="143.20" nrBC="1" totBC="30.25" nrA="0" totA="0" nrR="0" totR="0" nrM="0" totM="0" totTva="23.20" totTvaC="5.25" totTaxe="0" totNet="0" sume_serv_in="100" sume_serv_out="100" monRef="RON">
<pl tipP="3" valPl="43.20" monPl="RON"/><pl tipP="1" valPl="100.00" monPl="RON"/>
<coteZ cota="21" valOp="121.00" tva="21.00"/><coteZ cota="11" valOp="22.20" tva="2.20"/>
</rB></msj>`;

  test("reads the register's daily file (A4203): plain, or in its signed envelope", () => {
    const company = { name: 'Magazin Exemplu SRL', taxId: '18547290' };
    const plain = parseA4203(new TextEncoder().encode(a4203), company);
    expect(plain).toMatchObject({
      register: '4400012345',
      number: '7',
      issueDate: '2026-10-22',
      time: '21:05:00',
      receipts: 5,
      totals: { gross: '143.20', tax: '23.20' },
      buyerCode: { receipts: 1, gross: '30.25', tax: '5.25' },
      signed: false,
    });
    expect(plain.payments.map((row) => row.method)).toEqual(['cash', 'card']);
    expect(zReportProblems(plain)).toEqual([]);
    // CMS SignedData, its content the XML (DER, definite lengths), then base64.
    const der = (tag: number, body: number[]) => {
      const length =
        body.length < 0x80
          ? [body.length]
          : body.length < 0x100
            ? [0x81, body.length]
            : [0x82, body.length >> 8, body.length & 0xff];
      return [tag, ...length, ...body];
    };
    const xml = [...new TextEncoder().encode(a4203)];
    const oid = (bytes: number[]) => der(0x06, bytes);
    const envelope = der(0x30, [
      ...oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]),
      ...der(0xa0, [
        ...der(0x30, [
          ...der(0x02, [1]),
          ...der(0x31, []),
          ...der(0x30, [
            ...oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]),
            ...der(0xa0, der(0x04, xml)),
          ]),
          ...der(0x31, []),
        ]),
      ]),
    ]);
    expect(new TextDecoder().decode(amefXmlBytes(new Uint8Array(envelope)).xml)).toBe(a4203);
    const signed = parseA4203(
      new TextEncoder().encode(Buffer.from(envelope).toString('base64')),
      company,
    );
    expect(signed.signed).toBe(true);
    expect(() =>
      parseA4203(new TextEncoder().encode(a4203), { ...company, taxId: '14399840' }),
    ).toThrow('altui utilizator');
  });

  const loaded = (body: ZReportDocument, extra: [string, string][]): Loaded => ({
    ...emptyLoaded(facts(extra)),
    documents: new Map([[REPORT, record(body)]]),
  });

  test('books the day: cash, cards in transit, revenue and VAT by rate', () => {
    const evaluation = zReportRecognition.evaluate(
      zReportBookingInput.parse({ documentId: REPORT, cash: '5311', card: '5125', account: '704' }),
      loaded(day(), [['policy.stock.inventory', 'intermittent']]),
      rules(),
    );
    expect(evaluation.issues.map((issue) => issue.code)).toEqual(['REDUCED_RATE']);
    expect(lines(evaluation.effect)).toEqual([
      'C 704 100.00',
      'C 704 20.00',
      'C 4427 21.00',
      'C 4427 2.20',
      'D 5311 43.20',
      'D 5125 100.00',
    ]);
    expect(
      evaluation.effect!.taxEntries.map((entry) => [entry.code, entry.baseBani, entry.taxBani]),
    ).toEqual([
      ['S-21', 10_000n, 2_100n],
      ['S-11', 2_000n, 220n],
    ]);
    expect(evaluation.effect!.lines[5]!.analytics).toEqual({ item: `zreport:${REPORT}` });
  });

  test('goods at cost with only totals: a question; unsupported means of payment and amounts refused', () => {
    const asked = zReportRecognition.evaluate(
      zReportBookingInput.parse({ documentId: REPORT, cash: '5311', card: '5125', account: '707' }),
      loaded(day(), [
        ['policy.stock.inventory', 'permanent'],
        ['policy.stock.retail', 'cost'],
      ]),
      rules(),
    );
    expect(asked.effect).toBe(null);
    const question = asked.issues.find((issue) => issue.code === 'ZREPORT_GOODS')!;
    expect(question.details).toMatchObject({
      question: { kind: 'retail.goods', subject: { kind: 'document', id: REPORT } },
    });
    const voucher = zReportRecognition.evaluate(
      zReportBookingInput.parse({ documentId: REPORT, cash: '5311', account: '704' }),
      loaded(day({ payments: [{ method: 'voucher', amount: '143.20', currency: 'RON' }] }), [
        ['policy.stock.inventory', 'intermittent'],
      ]),
      rules(),
    );
    expect(voucher.issues.map((issue) => issue.code)).toContain('ZREPORT_PAYMENT');
    const deposit = zReportRecognition.evaluate(
      zReportBookingInput.parse({ documentId: REPORT, cash: '5311', card: '5125', account: '704' }),
      loaded(
        day({
          otherTaxes: '0.50',
          totals: { gross: '143.70', tax: '23.20' },
          payments: [
            { method: 'cash', amount: '43.70', currency: 'RON' },
            { method: 'card', amount: '100.00', currency: 'RON' },
          ],
        }),
        [['policy.stock.inventory', 'intermittent']],
      ),
      rules(),
    );
    expect(deposit.issues.map((issue) => issue.code)).toContain('ZREPORT_OTHER_TAXES');
  });

  test('an invoice for receipts: one sale with its Z report, two tax entries that cancel out', () => {
    const invoice: DocumentRecord = {
      id: INVOICE,
      kind: 'invoice.issued',
      schema: 'ubl-invoice-4',
      body: {
        parserVersion: 'ubl-invoice-4',
        documentType: 'invoice',
        number: 'XF0001',
        issueDate: '2026-10-22',
        taxPointDate: null,
        currency: 'RON',
        supplier: { name: 'Magazin Exemplu SRL', taxId: 'RO18547290', country: 'RO' },
        customer: { name: 'Ion Popescu', taxId: '0000000000000', country: 'RO' },
        originalInvoiceNumber: null,
        customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1',
        lines: [{ id: '1', description: 'Cafea', net: '25.00', vatCategory: 'S', vatRate: '21' }],
        taxes: [{ base: '25.00', tax: '5.25', category: 'S', rate: '21', exemptionReason: null }],
        totals: {
          lineNet: '25.00',
          net: '25.00',
          tax: '5.25',
          gross: '30.25',
          allowances: '0.00',
          charges: '0.00',
          prepaid: '0.00',
          rounding: '0.00',
          payable: '30.25',
        },
      } as never,
      bodyHash: 'i',
      docDate: '2026-10-22' as LocalDate,
      partyId: BUYER,
      currency: 'RON',
      number: 'XF0001',
      evidenceId: null,
    };
    const evaluation = receiptInvoiceRecognition.evaluate(
      receiptInvoiceInput.parse({ documentId: INVOICE, zReportId: REPORT, receipts: ['0003'] }),
      {
        ...emptyLoaded(facts([])),
        documents: new Map([
          [REPORT, record(day())],
          [INVOICE, invoice],
        ]),
      },
      rules(),
    );
    expect(evaluation.issues).toEqual([]);
    expect(evaluation.effect!.journalClass).toBe('memo');
    expect(evaluation.effect!.lines).toEqual([]);
    expect(
      evaluation.effect!.taxEntries.map((entry) => [
        entry.code,
        entry.baseBani,
        entry.taxBani,
        entry.attributes.documentType,
      ]),
    ).toEqual([
      ['S-21', 2_500n, 525n, 'invoice'],
      ['S-21', -2_500n, -525n, 'zreport'],
    ]);
  });
});

describe('the retail price method', () => {
  const postings = (
    rows: [string, string, 'D' | 'C', bigint][],
    queries: { prefixes: string[]; from: LocalDate; to: LocalDate }[],
  ) => {
    const turnover = new Map<string, readonly AccountTurnover[]>();
    for (const query of queries) {
      const held = new Map<string, AccountTurnover>();
      for (const [date, account, side, bani] of rows) {
        if (
          date < query.from ||
          date > query.to ||
          !query.prefixes.some((prefix) => account.startsWith(prefix))
        )
          continue;
        const row = held.get(account) ?? { account, debit: 0n, credit: 0n };
        if (side === 'D') row.debit += bani;
        else row.credit += bani;
        held.set(account, row);
      }
      turnover.set(turnoverKey(query), [...held.values()]);
    }
    return turnover;
  };
  const shop = (extra: Partial<Loaded> = {}): Loaded => ({
    ...emptyLoaded(
      facts([
        ['policy.stock.retail', 'retail'],
        ['policy.stock.inventory', 'permanent'],
      ]),
    ),
    years: [
      {
        id: 'fy',
        kind: 'financial',
        from: '2026-01-01' as LocalDate,
        to: '2026-12-31' as LocalDate,
      },
    ],
    warehouses: new Map([
      [STORE, { id: STORE, code: 'M2', name: 'Magazin', keeper: 'Ionescu Maria' }],
    ]),
    evidence: new Map([
      [
        '00000000-0000-4000-8000-00000000f009',
        {
          id: '00000000-0000-4000-8000-00000000f009',
          hash: 'h',
          filename: 'lista.pdf',
          mediaType: 'application/pdf',
        },
      ],
    ]),
    ...extra,
  });
  const ledger: [string, string, 'D' | 'C', bigint][] = [
    ['2026-10-05', '371.M2-21', 'D', 181_500n],
    ['2026-10-05', '4428.M2-21', 'C', 31_500n],
    ['2026-10-05', '378.M2', 'C', 50_000n],
    ['2026-10-20', '371.M2-21', 'C', 60_500n],
  ];

  test('discharges the month: the markup by the coefficient, the VAT its exits include', () => {
    const input = retailDischargeInput.parse({ month: '2026-10', warehouseId: STORE });
    const plan = retailDischarge.followUp!(input, shop())!;
    const evaluation = retailDischarge.evaluate(
      input,
      shop({ turnover: postings(ledger, plan.turnover!) }),
      rules(),
    );
    expect(evaluation.issues).toEqual([]);
    expect(lines(evaluation.effect)).toEqual([
      'D 378.M2 166.67',
      'C 607 166.67',
      'D 4428.M2-21 105.00',
      'C 607 105.00',
    ]);
    expect(
      evaluation
        .effect!.lines.filter((line) => line.account !== '607')
        .every((line) => line.analytics?.item === `retail:${STORE}`),
    ).toBe(true);
  });

  test("the year's coefficient applies to the year's exits, less what earlier months took", () => {
    // October as above, discharged (166,67 and 105,00); November receives 1.210,00 with a markup
    // of 100,00 (VAT 210,00) and sells 605,00: K = (500 + 100) ÷ (1.500 + 1.000) = 24%, on the
    // year's exits without VAT, 1.000,00: 240,00 − 166,67 = 73,33, so 378 keeps 600 − 240 = 360 =
    // 24% × the 1.500,00 still held. The month's exits alone (24% × 500 = 120,00) would leave
    // 313,33, at no coefficient.
    const november: [string, string, 'D' | 'C', bigint][] = [
      ...ledger,
      ['2026-10-31', '378.M2', 'D', 16_667n],
      ['2026-10-31', '4428.M2-21', 'D', 10_500n],
      ['2026-11-04', '371.M2-21', 'D', 121_000n],
      ['2026-11-04', '4428.M2-21', 'C', 21_000n],
      ['2026-11-04', '378.M2', 'C', 10_000n],
      ['2026-11-20', '371.M2-21', 'C', 60_500n],
    ];
    const input = retailDischargeInput.parse({ month: '2026-11', warehouseId: STORE });
    const plan = retailDischarge.followUp!(input, shop())!;
    const evaluation = retailDischarge.evaluate(
      input,
      shop({ turnover: postings(november, plan.turnover!) }),
      rules(),
    );
    expect(evaluation.issues).toEqual([]);
    expect(lines(evaluation.effect)).toEqual([
      'D 378.M2 73.33',
      'C 607 73.33',
      'D 4428.M2-21 105.00',
      'C 607 105.00',
    ]);
  });

  test('counts at sale price: a shortage leaves, its deducted VAT adjusted on its cost', () => {
    const input = retailCountInput.parse({
      date: '2026-10-31',
      warehouseId: STORE,
      evidenceId: '00000000-0000-4000-8000-00000000f009',
      rows: [{ rate: '21', counted: '1180.00' }],
      cause: 'unimputable',
    });
    const plan = retailCount.followUp!(input, shop())!;
    const evaluation = retailCount.evaluate(
      input,
      shop({ turnover: postings(ledger, plan.turnover!) }),
      rules(),
    );
    expect(evaluation.issues.map((issue) => issue.code)).toEqual(['PROFIT_SHORTAGE']);
    // 30,00 short: VAT included 5,21, without it 24,79, markup 8,26, cost 16,53, its VAT 3,47.
    expect(lines(evaluation.effect)).toEqual([
      'C 371.M2-21 30.00',
      'D 607 30.00',
      'D 635 3.47',
      'C 4426 3.47',
    ]);
    expect(evaluation.effect!.taxEntries[0]).toMatchObject({ code: 'ADJ-304', taxBani: -347n });
  });

  test('the retail accounts take only lines tagged with their warehouse', () => {
    const account = (code: string): AccountInfo => ({
      code,
      postable: true,
      controlKind: code.startsWith('371.') ? 'retail' : null,
      validFrom: '2015-01-01' as LocalDate,
      validTo: null,
    });
    const issues = validateEffect(
      {
        schema: 'effect@1',
        date: '2026-10-05' as LocalDate,
        journalClass: 'general',
        journalCode: 'GENERAL',
        description: 'Test',
        lines: [
          { account: '371.M2-21', side: 'D', bani: 100n },
          { account: '5311', side: 'C', bani: 100n },
        ],
        openItems: [],
        taxEntries: [],
        schedules: [],
        explanation: { summary: 'test' },
      },
      { account, openItem: () => undefined },
    );
    expect(issues.map((issue) => issue.code)).toEqual(['RETAIL_ACCOUNT']);
  });
});

describe('B2C e-Factura', () => {
  const rule = {
    unidentified: '0000000000000',
    field: 'BT-47' as const,
    receiptInvoices: 'transmit' as const,
  };
  test('13 zeros without a code, the CNP when given, a receipt invoice transmitted', () => {
    expect(b2cInvoice(rule, { identification: 'none', cnp: null, receiptInvoice: false })).toEqual({
      ok: true,
      legalId: '0000000000000',
      transmit: true,
    });
    const cnp = '1800101221144';
    expect(isValidCnp(cnp)).toBe(true);
    expect(b2cInvoice(rule, { identification: 'cnp', cnp, receiptInvoice: true })).toEqual({
      ok: true,
      legalId: cnp,
      transmit: true,
    });
    expect(
      b2cInvoice(rule, { identification: 'cnp', cnp: null, receiptInvoice: false }),
    ).toMatchObject({
      ok: false,
      code: 'B2C_CNP',
    });
  });
});

describe('D394 op2', () => {
  test("the registers' receipts by month, in rezumat2 and informatii", () => {
    const model: D394 = {
      period: { year: 2026, month: 10 },
      type: 'L',
      company: {
        cui: '18547290',
        caen: '4711',
        name: 'Magazin Exemplu SRL',
        address: 'Galați',
        phone: '0236123456',
      },
      representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați' },
      preparer: {
        kind: 'company',
        cui: '14399840',
        name: 'Contabil SRL',
        capacity: 'Împuternicit',
      },
      consultation: true,
      affiliates: false,
      operations: [],
      simplified: {},
      cashRegisters: [
        {
          month: 10,
          registers: 1,
          receipts: 45,
          total: 1289,
          byRate: { '21': { base: 900, vat: 189 }, '11': { base: 180, vat: 20 } },
        },
      ],
      series: [],
      issuedInvoices: { own: 0, byBeneficiaries: 0, byThirdParties: 0 },
      invoices: [],
      cashVatDeductible: {},
    };
    expect(checkD394(model).filter((check) => check.severity === 'error')).toEqual([]);
    const calculation = calculateD394(model);
    expect(calculation.operationsReported).toBe(true);
    // A rezumat2 for every rate op2 writes, the validator's R246–R255.
    expect(
      calculation.byRate.map((row) => [row.rate, row.cashRegisters.base, row.cashRegisters.vat]),
    ).toEqual([
      ['21', 900n, 189n],
      ['11', 180n, 20n],
      ['9', 0n, 0n],
      ['5', 0n, 0n],
      ['19', 0n, 0n],
      ['20', 0n, 0n],
    ]);
    const xml = writeD394(model);
    expect(xml).toContain('nr_BF_i1="45" incasari_i1="1289"');
    expect(xml).toContain('baza_incasari_i1="900" tva_incasari_i1="189"');
    expect(xml).toMatch(
      /<op2 tip_op2="I1" luna="10" nrAMEF="1" nrBF="45" total="1289"[^>]*baza21="900" baza11="180" TVA21="189" TVA11="20"\/>/,
    );
  });
});

describe('agent-ready and reviewable', () => {
  test('its readings are specs with engine-computed cases', () => {
    const keys = reviewSpecs.map((spec) => spec.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'ro.stock.retail.coefficient',
        'ro.retail.zreport',
        'ro.efactura.b2c',
      ]),
    );
    const register = roRegister();
    for (const key of ['ro.stock.retail.coefficient', 'ro.retail.zreport', 'ro.efactura.b2c']) {
      const spec = reviewSpecs.find((item) => item.key === key)!;
      const outcomes = spec.cases.map((item) => item.run(register));
      expect(
        outcomes.some((outcome) => outcome.engine.summary !== outcome.alternative.summary),
      ).toBe(true);
      for (const outcome of outcomes)
        expect(outcome.engine.summary).not.toContain('Blocat: RULE_GAP');
    }
    // The coefficient's second case differs between the readings: 25% on the year's exits less
    // January's 1.000,00, against 26,67% on February's.
    const coefficient = reviewSpecs.find((item) => item.key === 'ro.stock.retail.coefficient')!;
    const second = coefficient.cases[1]!.run(register);
    expect(second.engine.summary).toContain('D 378.M1 1.500,00 lei');
    expect(second.alternative.summary).toContain('D 378.M1 1.333,33 lei');
  });
});
