import {
  turnoverKey,
  type AccountTurnover,
  type DocumentRecord,
  type Evaluation,
  type Loaded,
  type ProfileFact,
} from '../../../kernel';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { b2cInvoice, type B2cBuyer } from '../../retail/b2c';
import { zReportDocumentSchema, type ZReportDocument } from '../../retail/documents';
import type { B2cRule, ZReportRule } from '../../retail/parameters';
import { retailDischarge, retailDischargeInput } from '../../retail/retail';
import { zReportBookingInput, zReportRecognition } from '../../retail/zreport';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of retail and B2C (src/ro/retail) the texts leave open: over which period the
 * coefficient of the retail price method is computed (OMFP nr. 1.802/2014 pct. 286 alin. (4):
 * the year's opening balances and the entries cumulated from its start, or the month's own); where
 * meal tickets received in payment wait for their issuer (5328, by the function of 532, or a claim
 * on the issuer); and whether an invoice issued at an individual's request for a fiscal receipt
 * goes to RO e-Factura (OUG nr. 120/2021 art. 10^1 alin. (2) excepts the receipts). Each case runs
 * the engine's code on fixed figures, against the register under review.
 */

const OMFPA = 'OMFP1802/2014-A';
const STORE = '00000000-0000-4000-8000-00000000e001';
const REPORT = '00000000-0000-4000-8000-00000000e002';

const withValue = (register: ParameterRegister, key: string, value: unknown) =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );
const valueOf = <T>(register: ParameterRegister, key: string) =>
  register.versions.find((version) => version.key === key)!.value as T;

function outcome(
  evaluation: Evaluation,
  register: ParameterRegister,
  rules: RuleContext,
): CaseOutcome {
  const parameters = [...rules.used.keys()].map((id) => {
    const version = register.versions.find((item) => item.id === id);
    return `Parametru ${id} = ${JSON.stringify(version?.value)}`;
  });
  const issues = evaluation.issues.map(
    (issue) =>
      `${issue.severity === 'block' ? 'Blocare' : issue.severity === 'ack' ? 'De confirmat' : 'Informare'} ${issue.code}: ${issue.message}`,
  );
  if (!evaluation.effect)
    return {
      summary: `Blocat: ${[...new Set(evaluation.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code))].join(', ')}`,
      lines: [...issues, ...parameters],
    };
  const lines = evaluation.effect.lines.map(
    (line) => `${line.side} ${line.account} ${lei(line.bani)} lei`,
  );
  return { summary: `Propus: ${lines.join('; ')}`, lines: [...issues, ...parameters] };
}

function run(register: ParameterRegister, evaluate: (rules: RuleContext) => Evaluation) {
  const rules = new RuleContext(register, 'preview');
  try {
    return outcome(evaluate(rules), register, rules);
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
}

const facts = (extra: [string, string][] = []): ProfileFact[] =>
  [
    ['vat.status', 'normal_vat'],
    ['vat.period', 'monthly'],
    ['policy.stock.retail', 'retail'],
    ['policy.stock.inventory', 'permanent'],
    ...extra,
  ].map(([axis, value]) => ({
    axis: axis!,
    value: value!,
    effectiveFrom: '2026-01-01' as LocalDate,
  }));

/** A posting on a retail account: date, account, side, bani. */
type Posting = [string, string, 'D' | 'C', bigint];

/** A shop's warehouse M1 at retail price, with the postings given, read as the treatment asks. */
function shop(
  postings: Posting[],
  plan: (
    loaded: Loaded,
  ) => { turnover?: { prefixes: string[]; from: LocalDate; to: LocalDate }[] } | null,
): Loaded {
  const loaded: Loaded = {
    ...emptyLoaded(facts()),
    years: [
      {
        id: 'fy-2026',
        kind: 'financial',
        from: '2026-01-01' as LocalDate,
        to: '2026-12-31' as LocalDate,
      },
    ],
    warehouses: new Map([
      [STORE, { id: STORE, code: 'M1', name: 'Magazin', keeper: 'Ionescu Maria' }],
    ]),
  };
  const queries = plan(loaded)?.turnover ?? [];
  const turnover = new Map<string, readonly AccountTurnover[]>();
  for (const query of queries) {
    const rows = new Map<string, AccountTurnover>();
    for (const [date, account, side, bani] of postings) {
      if (date < query.from || date > query.to) continue;
      if (!query.prefixes.some((prefix) => account.startsWith(prefix))) continue;
      const row = rows.get(account) ?? { account, debit: 0n, credit: 0n };
      if (side === 'D') row.debit += bani;
      else row.credit += bani;
      rows.set(account, row);
    }
    turnover.set(turnoverKey(query), [...rows.values()]);
  }
  return { ...loaded, turnover };
}

// ---------------------------------------------------------------------------------------------
// The coefficient of the retail price method (pct. 286 alin. (4) and (8))

/** A NIR at sale price: the goods at 21% at their sale price, with the markup and the VAT. */
const reception = (date: string, sale: bigint, markup: bigint): Posting[] => {
  const vat = (sale * 21n * 2n + 121n) / 242n;
  return [
    [date, '371.M1-21', 'D', sale],
    [date, '378.M1', 'C', markup],
    [date, '4428.M1-21', 'C', vat],
  ];
};
const exit = (date: string, gross: bigint): Posting => [date, '371.M1-21', 'C', gross];
const discharged = (date: string, markup: bigint, vat: bigint): Posting[] => [
  [date, '378.M1', 'D', markup],
  [date, '4428.M1-21', 'D', vat],
];

function coefficientCase(
  title: string,
  facts_: string,
  month: string,
  postings: Posting[],
): ReviewCase {
  const input = retailDischargeInput.parse({ month, warehouseId: STORE });
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) =>
      retailDischarge.evaluate(
        input,
        shop(postings, (loaded) => retailDischarge.followUp!(input, loaded)),
        rules,
      ),
    );
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(withValue(register, 'ro.stock.retail.coefficient', { basis: 'month' })),
    }),
  };
}

export const retailCoefficientSpec: ReviewSpec = {
  key: 'ro.stock.retail.coefficient',
  kind: 'interpretation',
  act: OMFPA,
  minutes: 15,
  readings: {
    engine:
      'Coeficientul lunii se calculează din soldul de la începutul exercițiului al adaosului (378) și al mărfurilor (371) plus intrările cumulate de la începutul exercițiului până la sfârșitul lunii, fără TVA neexigibilă, și se aplică ieșirilor cumulate de la începutul exercițiului fără TVA, minus adaosul descărcat în lunile anterioare, astfel încât adaosul rămas să fie coeficientul înmulțit cu stocul (alin. (7)).',
    alternative:
      'Coeficientul lunii se calculează din soldurile de la începutul lunii și intrările lunii (practica obișnuită), fără TVA neexigibilă, și se aplică ieșirilor lunii fără TVA.',
  },
  question:
    'La metoda prețului cu amănuntul (OMFP nr. 1.802/2014 pct. 286 alin. (8)), coeficientul de repartizare a adaosului asupra mărfurilor vândute (alin. (4) și nota *2)) se calculează din soldul inițial al exercițiului și intrările cumulate de la începutul exercițiului, sau din soldul inițial și intrările lunii?',
  context: [`${OMFPA}:pct.291(5)`],
  cases: [
    coefficientCase(
      'Prima lună',
      'Ianuarie: recepție la preț de vânzare 12.100,00 lei (TVA neexigibilă 2.100,00, adaos 2.000,00); vânzări 6.050,00 lei cu TVA.',
      '2026-01',
      [...reception('2026-01-05', 1_210_000n, 200_000n), exit('2026-01-20', 605_000n)],
    ),
    coefficientCase(
      'Adaosul crește în a doua lună',
      'Ianuarie ca mai sus, descărcat (adaos 1.000,00, TVA 1.050,00); februarie: recepție de 12.100,00 lei cu adaos 3.000,00, vânzări 6.050,00 lei.',
      '2026-02',
      [
        ...reception('2026-01-05', 1_210_000n, 200_000n),
        exit('2026-01-20', 605_000n),
        ...discharged('2026-01-31', 100_000n, 105_000n),
        ...reception('2026-02-03', 1_210_000n, 300_000n),
        exit('2026-02-18', 605_000n),
      ],
    ),
    coefficientCase(
      'Adaosul scade în a doua lună',
      'Ianuarie ca mai sus, descărcat; februarie: recepție de 12.100,00 lei cu adaos 1.000,00, vânzări 6.050,00 lei.',
      '2026-02',
      [
        ...reception('2026-01-05', 1_210_000n, 200_000n),
        exit('2026-01-20', 605_000n),
        ...discharged('2026-01-31', 100_000n, 105_000n),
        ...reception('2026-02-03', 1_210_000n, 100_000n),
        exit('2026-02-18', 605_000n),
      ],
    ),
  ],
  gaps: [
    'Coeficientul se calculează pe gestiune (pct. 286 alin. (5) permite și conturi sintetice, grupe sau categorii); calculul pe grupe nu este construit.',
    'O stornare în negru a unei descărcări din raportul Z apare ca o intrare, nu ca o ieșire: stornările din gestiunile la preț cu amănuntul se fac în roșu.',
  ],
};

// ---------------------------------------------------------------------------------------------
// Meal tickets received in payment (`ro.retail.zreport`)

const zReport = (payments: ZReportDocument['payments']): DocumentRecord => ({
  id: REPORT,
  kind: 'zreport',
  schema: 'extracted-zreport-1',
  body: zReportDocumentSchema.parse({
    parserVersion: 'extracted-zreport-1',
    seller: { name: 'Magazin Exemplu SRL', taxId: 'RO100', country: 'RO' },
    register: '4400012345',
    number: '42',
    issueDate: '2026-03-10',
    time: '21:05:00',
    receipts: 40,
    currency: 'RON',
    taxes: [{ rate: '21', gross: '1210.00', tax: '210.00' }],
    exempt: '0.00',
    otherTaxes: '0.00',
    totals: { gross: '1210.00', tax: '210.00' },
    buyerCode: null,
    cancellations: null,
    discounts: null,
    surcharges: null,
    serviceSums: null,
    payments,
    journalId: null,
    cumulative: null,
    failures: null,
    items: [],
  }) as never,
  bodyHash: 'z',
  docDate: '2026-03-10' as LocalDate,
  partyId: null,
  currency: 'RON',
  number: '42',
  evidenceId: null,
});

function ticketsCase(
  title: string,
  facts_: string,
  payments: ZReportDocument['payments'],
): ReviewCase {
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) => {
      const rule = valueOf<ZReportRule>(register, 'ro.retail.zreport');
      const loaded = {
        ...emptyLoaded(
          facts([
            ['policy.stock.retail', 'cost'],
            ['policy.stock.inventory', 'intermittent'],
          ]),
        ),
        documents: new Map([[REPORT, zReport(payments)]]),
      };
      return zReportRecognition.evaluate(
        zReportBookingInput.parse({
          documentId: REPORT,
          cash: '5311',
          card: rule.card,
          tickets: rule.tickets,
          account: '704',
        }),
        loaded,
        rules,
      );
    });
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.retail.zreport', {
          ...valueOf<ZReportRule>(register, 'ro.retail.zreport'),
          tickets: '461',
        }),
      ),
    }),
  };
}

export const retailZReportSpec: ReviewSpec = {
  key: 'ro.retail.zreport',
  kind: 'interpretation',
  act: 'OUG28/1999',
  minutes: 10,
  readings: {
    engine:
      'Încasările cu cardul rămân în 5125 „Sume în curs de decontare” până la decontarea băncii (pct. 302 alin. (2)); tichetele de masă și valorice primite în plată se țin în 5328 „Alte valori” până le decontează emitentul.',
    alternative:
      'Tichetele primite în plată sunt o creanță asupra emitentului lor (461 „Debitori diverși”), pentru că funcțiunea contului 532 privește tichetele achiziționate de entitate.',
  },
  question:
    'Într-un raport Z, unde se înregistrează tichetele de masă și valorice primite de la clienți în plată, până la decontarea lor de către emitent: în 5328 „Alte valori” sau în 461 „Debitori diverși”?',
  context: ['OUG28/1999:art.4(5)-(9)', 'ANAF/A4203:structura'],
  cases: [
    ticketsCase(
      'Numerar, card și tichete',
      'Ziua: 1.210,00 lei la 21%, plătiți 500,00 numerar, 610,00 card, 100,00 tichete de masă.',
      [
        { method: 'cash', amount: '500.00', currency: 'RON' },
        { method: 'card', amount: '610.00', currency: 'RON' },
        { method: 'mealTickets', amount: '100.00', currency: 'RON' },
      ],
    ),
    ticketsCase('Doar numerar', 'Ziua: 1.210,00 lei la 21%, plătiți integral în numerar.', [
      { method: 'cash', amount: '1210.00', currency: 'RON' },
    ]),
    ticketsCase(
      'Bonuri valorice și card',
      'Ziua: 1.210,00 lei la 21%, plătiți 1.000,00 card și 210,00 bonuri valorice.',
      [
        { method: 'card', amount: '1000.00', currency: 'RON' },
        { method: 'valueTickets', amount: '210.00', currency: 'RON' },
      ],
    ),
  ],
  gaps: [
    'HG nr. 479/2003 (normele OUG nr. 28/1999) nu a fost obținută: regulile ei privind raportul Z și registrul special nu sunt citite.',
    'Voucherele, avansurile în numerar, vânzările pe credit și metodele moderne de plată din raportul Z nu sunt acoperite.',
    'Comisionul emitentului tichetelor la decontare nu este construit.',
  ],
};

// ---------------------------------------------------------------------------------------------
// An invoice issued for a fiscal receipt, and an individual's identification (`ro.efactura.b2c`)

function b2cCase(title: string, facts_: string, buyer: B2cBuyer): ReviewCase {
  const evaluate = (register: ParameterRegister): CaseOutcome => {
    const rules = new RuleContext(register, 'preview');
    try {
      const rule = rules.param<B2cRule>(
        'ro.efactura.b2c',
        'invoice_issue_date',
        '2026-10-15' as LocalDate,
      );
      const result = b2cInvoice(rule, buyer);
      return result.ok
        ? {
            summary: `BT-47 ${result.legalId.replace(/^\d{13}$/, (code) => (code === rule.unidentified ? code : 'CNP-ul cumpărătorului'))}; ${result.transmit ? 'se transmite în RO e-Factura în 5 zile lucrătoare' : 'nu se transmite în RO e-Factura'}`,
            lines: [`Parametru ro.efactura.b2c = ${JSON.stringify(rule)}`],
          }
        : { summary: `Blocat: ${result.code}`, lines: [result.message] };
    } catch (error) {
      if (error instanceof RuleGapError)
        return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
      throw error;
    }
  };
  return {
    title,
    facts: facts_,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.efactura.b2c', {
          ...valueOf<B2cRule>(register, 'ro.efactura.b2c'),
          receiptInvoices: 'exempt',
        }),
      ),
    }),
  };
}

export const efacturaB2cSpec: ReviewSpec = {
  key: 'ro.efactura.b2c',
  kind: 'interpretation',
  act: 'OUG120/2021-A',
  minutes: 10,
  readings: {
    engine:
      'Factura emisă la cererea unei persoane fizice pentru un bon fiscal este o factură în relația B2C și se transmite în RO e-Factura: art. 10^1 alin. (2) exceptează bonurile fiscale, nu facturile emise pentru ele; fără niciun cod, cumpărătorul se scrie cu 13 cifre de zero în BT-47.',
    alternative:
      'Factura emisă pentru un bon fiscal care îndeplinește condițiile facturii simplificate nu se transmite, documentul tranzacției fiind bonul exceptat.',
  },
  question:
    'O factură emisă la cererea unei persoane fizice pentru o vânzare documentată deja printr-un bon fiscal (art. 319 alin. (10) lit. a) din Codul fiscal) se transmite în RO e-Factura (OUG nr. 120/2021 art. 10^1 alin. (2))?',
  context: ['OUG120/2021-A:art.2(1)(n^1)', 'ANAF/Cod-fiscal-consolidat:art.319(10)(a)'],
  cases: [
    b2cCase(
      'Factură pentru bon, fără cod',
      'Cumpărătorul cere factura pentru bonul de ieri și nu își dă CNP-ul.',
      {
        identification: 'none',
        cnp: null,
        receiptInvoice: true,
      },
    ),
    b2cCase(
      'Factură pentru bon, cu CNP',
      'Cumpărătorul cere factura pentru bon și își dă CNP-ul, înregistrat sigilat.',
      {
        identification: 'cnp',
        cnp: '1800101221144',
        receiptInvoice: true,
      },
    ),
    b2cCase(
      'Factură fără bon, fără cod',
      'O livrare către o persoană fizică facturată direct, fără bon fiscal, fără cod.',
      {
        identification: 'none',
        cnp: null,
        receiptInvoice: false,
      },
    ),
  ],
  gaps: [
    'Artefactele de validare CIUS-RO (schematron) de pe mfinante.gov.ro nu au putut fi descărcate automat: locul codului de 13 cifre de zero (BT-47) urmează ghidul ANAF v2.9 și locul în care aplicația scrie CNP-ul.',
    'Un cumpărător persoană fizică înscris în Registrul RO e-Factura opțional nu este acoperit.',
  ],
};
