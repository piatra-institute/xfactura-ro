import type {
  Evaluation,
  FxRate,
  LineSpec,
  Loaded,
  OpenItemState,
  PostedEntry,
} from '../../../kernel';
import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../../ubl/invoice-document';
import {
  creditInput,
  creditRecognition,
  invoiceKinds,
  invoiceRecognition,
  recognitionInput,
} from '../../treatments/invoices';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of credit notes in a currency, from the clauses as ANAF's consolidated Fiscal Code
 * gives them (snapshot ANAF/Cod-fiscal-consolidat, sha256 aba0c753…): art. 282 alin. (9) and the
 * norms' pct. 25 alin. (2), art. 290 alin. (2) and the norms' pct. 35 alin. (6); and OMFP nr.
 * 1.802/2014 as ANAF publishes it (pct. 314, 319, 322, 330). The world below is fixed: an invoice
 * in euro of 10.03.2026 booked by `invoices.recognize`, then its credit note booked by
 * `invoices.credit`, against the register under review.
 */

const COMPANY = { name: 'Companie exemplu SRL', taxId: 'RO18547290', country: 'RO' };
const PARTNER = { name: 'Partener exemplu SRL', taxId: 'RO14399840', country: 'RO' };
export const creditIds = {
  original: '00000000-0000-4000-8000-0000000000f1',
  credit: '00000000-0000-4000-8000-0000000000f2',
  partner: '00000000-0000-4000-8000-0000000000f3',
  item: '00000000-0000-4000-8000-0000000000f4',
  entry: '00000000-0000-4000-8000-0000000000f5',
  revaluation: '00000000-0000-4000-8000-0000000000f6',
  settlement: '00000000-0000-4000-8000-0000000000f7',
};

/** BNR's euro rates of the world, newest first, as the kernel loads them. */
export const creditRatesOfWorld: readonly FxRate[] = [
  ['2026-04-08', '5.0100'],
  ['2026-03-31', '4.9900'],
  ['2026-03-20', '4.9850'],
  ['2026-03-10', '4.9765'],
].map(([day, rate]) => ({
  id: `BNR/EUR/${day}/1`,
  source: 'BNR',
  currency: 'EUR',
  date: day as LocalDate,
  rate: rate!,
  multiplier: 1,
}));

const text = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const cents = (value: string) => BigInt(value.replace('.', ''));

/** An invoice or credit note in euro at 21%, its VAT in lei as it states it (BT-111). */
export function euroDocument(options: {
  credit?: boolean;
  purchase?: boolean;
  number: string;
  issueDate: string;
  net: string;
  ronVat: string;
  original?: string;
}): InvoiceDocument {
  const net = cents(options.net);
  const tax = (net * 21n + 50n) / 100n;
  return invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: options.credit ? 'credit_note' : 'invoice',
    number: options.number,
    issueDate: options.issueDate,
    taxPointDate: null,
    currency: 'EUR',
    vatCurrency: 'RON',
    vatAccountingTotal: options.ronVat,
    supplier: options.purchase ? PARTNER : COMPANY,
    customer: options.purchase ? COMPANY : PARTNER,
    originalInvoiceNumber: options.original ?? null,
    customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1',
    lines: [{ id: '1', description: 'Servicii', net: text(net), vatCategory: 'S', vatRate: '21' }],
    taxes: [{ base: text(net), tax: text(tax), category: 'S', rate: '21', exemptionReason: null }],
    totals: {
      lineNet: text(net),
      net: text(net),
      tax: text(tax),
      gross: text(net + tax),
      allowances: '0.00',
      charges: '0.00',
      prepaid: '0.00',
      rounding: '0.00',
      payable: text(net + tax),
    },
  });
}

/**
 * A VAT payer's books holding an invoice in euro (1.000,00 + 210,00 EUR of 10.03.2026, VAT
 * 1.045,07 lei at 4,9765) as `invoices.recognize` booked it, its receivable or payable revalued at
 * 31.03.2026 (`revalued`) or settled (`settled`), and the credit note.
 */
export function creditLoaded(
  register: ParameterRegister,
  credit: InvoiceDocument,
  options: { purchase?: boolean; revalued?: boolean; settled?: boolean } = {},
): Loaded {
  const loaded = emptyLoaded([
    { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
  ]);
  const purchase = options.purchase ?? false;
  const documents = loaded.documents as Map<string, unknown>;
  const original = euroDocument({
    purchase,
    number: 'EXP-1',
    issueDate: '2026-03-10',
    net: '1000.00',
    ronVat: '1045.07',
  });
  const record = (id: string, body: InvoiceDocument, kind: string) =>
    documents.set(id, {
      id,
      kind,
      schema: 'invoice',
      body,
      bodyHash: 'example',
      docDate: body.issueDate,
      partyId: creditIds.partner,
      currency: 'EUR',
      number: body.number,
      evidenceId: null,
    });
  record(creditIds.original, original, purchase ? invoiceKinds.purchase : invoiceKinds.sale);
  record(
    creditIds.credit,
    credit,
    purchase ? invoiceKinds.purchaseCredit : invoiceKinds.saleCredit,
  );
  (loaded.fxRates as Map<string, readonly FxRate[]>).set('EUR', creditRatesOfWorld);
  // The invoice, as the engine books it.
  const booked = invoiceRecognition.evaluate(
    recognitionInput.parse({ documentId: creditIds.original, account: purchase ? '628' : '704' }),
    loaded,
    new RuleContext(register, 'preview'),
  ).effect!;
  const lines: LineSpec[] = booked.lines.map((line) =>
    line.openItem === 'counterparty' ? { ...line, openItem: creditIds.item } : line,
  );
  const entries = loaded.entries as Map<string, PostedEntry>;
  entries.set(creditIds.entry, {
    id: creditIds.entry,
    number: 1,
    date: booked.date,
    journalCode: booked.journalCode,
    description: booked.description,
    lines,
    taxEntries: booked.taxEntries,
  });
  const control = lines.find((line) => line.openItem === creditIds.item)!;
  const sign = purchase ? -1n : 1n;
  const history = [creditIds.entry];
  let bani = sign * control.bani;
  let minor = sign * control.currency!.minor;
  if (options.revalued) {
    // 1.210,00 EUR at 4,9900: 6.037,90 lei, the difference on the item in lei only.
    const at = creditRatesOfWorld.find((rate) => rate.date === '2026-03-31')!;
    const difference = 603790n - control.bani;
    entries.set(creditIds.revaluation, {
      id: creditIds.revaluation,
      number: 2,
      date: '2026-03-31' as LocalDate,
      journalCode: 'DIVERSE',
      description: 'Reevaluare valutară la 2026-03-31',
      lines: [
        {
          account: control.account,
          side: purchase ? 'C' : 'D',
          bani: difference,
          openItem: creditIds.item,
          partyId: creditIds.partner,
          currency: { code: 'EUR', minor: 0n, rateId: at.id, rate: at.rate },
        },
      ],
      taxEntries: [],
    });
    history.push(creditIds.revaluation);
    bani += sign * difference;
  }
  if (options.settled) {
    history.push(creditIds.settlement);
    bani = 0n;
    minor = 0n;
  }
  const item: OpenItemState = {
    id: creditIds.item,
    kind: purchase ? 'payable' : 'receivable',
    controlAccount: control.account,
    partyId: creditIds.partner,
    currency: 'EUR',
    normalSide: purchase ? 'C' : 'D',
    mayReverse: false,
    balanceBani: bani,
    balanceMinor: minor,
    documentId: creditIds.original,
    dueDate: null,
    originEntryId: creditIds.entry,
    movements: history.length,
    history,
  };
  (loaded.openItems as Map<string, OpenItemState>).set(item.id, item);
  return loaded;
}

/** `invoices.credit` on the world's credit note. */
export function creditEvaluation(
  register: ParameterRegister,
  credit: InvoiceDocument,
  options: { purchase?: boolean; revalued?: boolean; settled?: boolean } = {},
): { evaluation: Evaluation; rules: RuleContext } {
  const loaded = creditLoaded(register, credit, options);
  const rules = new RuleContext(register, 'preview');
  const evaluation = creditRecognition.evaluate(
    creditInput.parse({
      documentId: creditIds.credit,
      originalDocumentId: creditIds.original,
      account: options.purchase ? '628' : '704',
    }),
    loaded,
    rules,
  );
  return { evaluation, rules };
}

const withValue = (register: ParameterRegister, key: string, value: unknown) =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );

function outcome(evaluation: Evaluation, rules: RuleContext): CaseOutcome {
  const issues = evaluation.issues.map(
    (issue) =>
      `${issue.severity === 'block' ? 'Blocare' : issue.severity === 'ack' ? 'De confirmat' : 'Informare'} ${issue.code}`,
  );
  const parameters = [...rules.used.keys()].map((id) => `Parametru ${id}`);
  const effect = evaluation.effect;
  if (!effect) return { summary: `Blocat: ${issues.join(', ')}`, lines: parameters };
  return {
    summary: `Propus${issues.length ? ` (${issues.join(', ')})` : ''}: ${effect.lines
      .map(
        (line) =>
          `${line.side === 'D' ? 'Dr' : 'Cr'} ${line.account} ${lei(line.bani)}${line.currency ? ` (${line.currency.rate})` : ''}`,
      )
      .join(' / ')}`,
    lines: [
      ...effect.taxEntries.map(
        (entry) =>
          `${entry.code}: bază ${lei(entry.baseBani)} lei, TVA ${lei(entry.taxBani)} lei, perioada ${entry.taxPeriod}, la cursul ${entry.currency?.rate ?? '—'}`,
      ),
      ...parameters,
    ],
  };
}

type CreditCaseOptions = {
  title: string;
  facts: string;
  issueDate: string;
  net: string;
  ronVat: string;
  purchase?: boolean;
  revalued?: boolean;
  settled?: boolean;
};

const creditNoteOf = (options: CreditCaseOptions) =>
  euroDocument({
    credit: true,
    purchase: options.purchase ?? false,
    number: 'CN-1',
    issueDate: options.issueDate,
    net: options.net,
    ronVat: options.ronVat,
    original: 'EXP-1',
  });

/** A case run under the engine's value of `key` and under `alternative`. */
function creditCase(key: string, alternative: unknown, options: CreditCaseOptions): ReviewCase {
  const run = (register: ParameterRegister) => {
    const { evaluation, rules } = creditEvaluation(register, creditNoteOf(options), options);
    return outcome(evaluation, rules);
  };
  return {
    title: options.title,
    facts: `${FACTS} ${options.facts}`,
    run: (register) => ({
      engine: run(register),
      alternative: run(withValue(register, key, alternative)),
    }),
  };
}

const FACTS =
  'Companie înregistrată în scopuri de TVA (regim normal, lunar). Factura EXP-1 din 10.03.2026, în euro: 1.000,00 EUR + TVA 21% 210,00 EUR, cu TVA în lei 1.045,07 lei (BT-111) la cursul BNR 4,9765 din data exigibilității, aceeași cu a emiterii. Cursurile BNR ale euro: 4,9850 la 20.03, 4,9900 la 31.03, 5,0100 la 08.04.2026.';

const VAT_CASES = (key: string, alternative: unknown): ReviewCase[] => [
  creditCase(key, alternative, {
    title: 'Reducere de preț de 100,00 EUR în aceeași lună, factura neîncasată',
    facts:
      'Nota de credit CN-1 din 20.03.2026: 100,00 EUR + 21,00 EUR, cu TVA în lei 104,51 lei (21,00 EUR la cursul facturii).',
    issueDate: '2026-03-20',
    net: '100.00',
    ronVat: '104.51',
  }),
  creditCase(key, alternative, {
    title: 'Reducere de 200,00 EUR în aprilie, după reevaluarea creanței la 31.03',
    facts:
      'Creanța a fost reevaluată la 31.03.2026 la 4,9900. Nota de credit CN-1 din 08.04.2026: 200,00 EUR + 42,00 EUR, cu TVA în lei 209,01 lei (la cursul facturii).',
    issueDate: '2026-04-08',
    net: '200.00',
    ronVat: '209.01',
    revalued: true,
  }),
  creditCase(key, alternative, {
    title: 'Nota de credit înscrie TVA în lei la cursul datei ei',
    facts:
      'Nota de credit CN-1 din 08.04.2026: 200,00 EUR + 42,00 EUR, cu TVA în lei 210,42 lei (42,00 EUR la cursul 5,0100 al datei notei).',
    issueDate: '2026-04-08',
    net: '200.00',
    ronVat: '210.42',
  }),
  creditCase(key, alternative, {
    title: 'Nota de credit a furnizorului pentru o achiziție plătită',
    facts:
      'Aceeași factură este o achiziție de servicii (628), plătită integral. Nota de credit a furnizorului din 20.03.2026: 100,00 EUR + 21,00 EUR, cu TVA în lei 104,51 lei; furnizorul datorează restituirea (461).',
    issueDate: '2026-03-20',
    net: '100.00',
    ronVat: '104.51',
    purchase: true,
    settled: true,
  }),
];

export const adjustmentVatSpec: ReviewSpec = {
  key: 'ro.fx.adjustment.vat',
  kind: 'mechanical',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 5,
  readings: {
    engine:
      'Baza de impozitare și TVA ale unei note de credit în valută (art. 287) se determină la cursul cu care s-a determinat baza facturii inițiale, cum îl înregistrează TVA ei (art. 282 alin. (9); norme pct. 25 alin. (2)); TVA în lei pe care o înscrie nota (BT-111) se compară cu acest curs, iar o diferență se confirmă (VAT_FX).',
    alternative:
      'Nota de credit este o operațiune a datei ei: baza și TVA ei se convertesc la cursul BNR valabil la data exigibilității notei (art. 290 alin. (2); norme pct. 35 alin. (6)).',
  },
  question:
    'Nota de credit din 08.04.2026 pentru factura în euro din 10.03.2026 (curs 4,9765) se declară în decontul de TVA cu baza și TVA la cursul facturii (4,9765) sau la cursul de la data notei (5,0100)?',
  context: [
    'ANAF/Cod-fiscal-consolidat:art.290(2)',
    'ANAF/Cod-fiscal-consolidat:norme.art.290.pct.35(6)',
  ],
  cases: VAT_CASES('ro.fx.adjustment.vat', 'event'),
  gaps: [
    'Teza finală a pct. 25 alin. (2) din norme (cota, regimul și cursul de la data evenimentului când operațiunea de bază nu se poate determina) nu este acoperită: invoices.credit cere factura inițială.',
    'Cursul BCE sau al băncii prin care se fac decontările, pe care art. 290 alin. (2) le admite prin contract, nu este folosit: cursul operațiunii de bază este cel BNR pe care l-a înregistrat factura.',
    'Nota de credit în sistemul TVA la încasare în valută rămâne refuzată, ca factura ei (CASH_VAT_CURRENCY).',
    'invoices.euConsumer citește același parametru pentru notele de credit către consumatori din alte state membre cu locul în România (TVA românească). Cu locul în statul membru (regimul special Uniune), TVA este a acelui stat și se declară în euro în D398 (art. 315): suma în lei a intrării fiscale rămâne la cursul notei, al liniei 4423, cum o raportează D406 (310340).',
  ],
};

export const adjustmentBooksSpec: ReviewSpec = {
  key: 'ro.fx.adjustment.books',
  kind: 'interpretation',
  act: 'OMFP1802/2014',
  minutes: 15,
  readings: {
    engine:
      'Nota de credit consemnează o operațiune a datei ei (pct. 314 alin. (2)–(3)): venitul sau cheltuiala pe care o reduce se înregistrează la cursul BNR al datei ei (pct. 319). Creanța sau datoria se reduce la valoarea ei contabilă (cursul facturii sau al ultimei reevaluări), restituirea care o depășește se deschide la cursul notei, iar diferența față de venit sau cheltuială și TVA este diferență de curs realizată, pe 665 sau 765 (pct. 322).',
    alternative:
      'Nota de credit corectează factura (pct. 330 alin. (1)): venitul sau cheltuiala se stornează la cursul facturii inițiale, ca și TVA, iar diferența de curs apare doar față de reevaluările creanței sau datoriei și față de restituire.',
  },
  question:
    'La nota de credit în euro din 20.03.2026 (curs 4,9850) pentru factura din 10.03.2026 (curs 4,9765), venitul se stornează la cursul datei notei, cu diferența față de creanță pe 7651 sau 6651, sau la cursul facturii, fără diferență de curs?',
  context: [
    'OMFP1802/2014:pct.314(2)-(3)',
    'OMFP1802/2014:pct.330(1)',
    'ANAF/Cod-fiscal-consolidat:art.282(9)',
  ],
  cases: VAT_CASES('ro.fx.adjustment.books', 'base_operation'),
  gaps: [
    'OMFP nr. 1.802/2014 nu spune la ce curs se stornează venitul sau cheltuiala unei note de credit în valută: pct. 319 vorbește de tranzacții, iar pct. 330 de corectarea conturilor la retururi, fără curs.',
    'Reducerile de preț acordate după facturare pot fi înregistrate pe 709 sau 609; motorul stornează pe contul pe care îl indică persoana (contul facturii inițiale).',
    'În D406, impozitul (TaxAmount) al liniei de bază a notei are cursul TVA (al facturii), iar linia cursul notei: fiecare sumă are cursul ei (Amount = CurrencyAmount × ExchangeRate, întrebările și răspunsurile SAF-T v1.2, MF.C.6).',
    'Bunurile pe care le mișcă o notă de credit în valută se mișcă în lei, la cost, nu la un curs: returul clientului la costul ieșirii inițiale, returul la furnizor la costul cu care a intrat recepția; diferența față de datoria eliberată la valoarea contabilă intră în diferența de curs.',
  ],
};
