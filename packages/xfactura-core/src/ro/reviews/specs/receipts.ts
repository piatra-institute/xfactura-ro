import type { AnswerRecord, Evaluation, FxRate, Loaded, PartyRecord } from '../../../kernel';
import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../../ubl/invoice-document';
import {
  documentKinds,
  receiptDocumentSchema,
  type ReceiptDocument,
} from '../../../documents/schemas';
import { invoiceKinds } from '../../treatments/invoices';
import { receiptRecognition, receiptRecognitionInput } from '../../receipts/receipts';
import {
  reverseChargeApplies,
  reverseChargeInput,
  reverseChargeRecognition,
} from '../../receipts/reverse-charge';
import type { ReverseChargeCategory, ReverseChargeRule } from '../../receipts/parameters';
import type { CaseOutcome, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings from the clauses as ANAF's consolidated Fiscal Code gives them (snapshot
 * ANAF/Cod-fiscal-consolidat, sha256 aba0c753…): art. 319 alin. (12), (13) and (21), art. 290
 * alin. (2), art. 299 alin. (1) lit. a), the norms' pct. 69 alin. (3) and (6) (receipts as
 * simplified invoices), art. 331 and the norms' pct. 109 (domestic reverse charge); the history of
 * alin. (12) and of art. 331 alin. (6) from the portal's consolidated form (LJR/Cod-fiscal-2025).
 * The worlds below are fixed; the treatments compute every outcome against the register.
 */

const RECEIPT = '00000000-0000-4000-8000-0000000000b1';
const INVOICE = '00000000-0000-4000-8000-0000000000b2';
const SELLER = '00000000-0000-4000-8000-0000000000b3';
const RATE: FxRate = {
  id: '00000000-0000-4000-8000-0000000000b4',
  source: 'BNR',
  currency: 'EUR',
  date: '2026-10-16' as LocalDate,
  rate: '5.0815',
  multiplier: 1,
};

/** A fuel receipt of 18.10.2026 at 21%: `gross` with VAT, the buyer's code as printed. */
export function fuelReceipt(options: {
  gross: string;
  tax: string;
  buyerTaxId: string | null;
  register?: string | null;
  issueDate?: string;
  lines?: ReceiptDocument['lines'];
  taxes?: ReceiptDocument['taxes'];
}): ReceiptDocument {
  return receiptDocumentSchema.parse({
    parserVersion: 'extracted-receipt-1',
    seller: { name: 'Benzinăria Exemplu SRL', taxId: 'RO29031773', country: 'RO' },
    buyerTaxId: options.buyerTaxId,
    number: '0042',
    register: options.register === undefined ? '4400012345' : options.register,
    issueDate: options.issueDate ?? '2026-10-18',
    time: '17:42',
    currency: 'RON',
    lines: options.lines ?? [
      { description: 'Motorină standard', gross: options.gross, vatRate: '21' },
    ],
    taxes: options.taxes ?? [{ rate: '21', gross: options.gross, tax: options.tax }],
    totals: { gross: options.gross, tax: options.tax },
    payment: 'card',
  });
}

/** A company registered for VAT (monthly), its books holding the receipt and BNR's euro rate of
 * Friday 16.10.2026; what else the case needs (answers, open items, balances, statuses) added. */
export function receiptLoaded(
  body: ReceiptDocument,
  extra: {
    answers?: readonly AnswerRecord[];
    status?: 'normal_vat' | 'non_vat';
    fx?: readonly FxRate[];
    parties?: readonly PartyRecord[];
    with?: (loaded: Loaded) => void;
  } = {},
): Loaded {
  const loaded = emptyLoaded([
    {
      axis: 'vat.status',
      value: extra.status ?? 'normal_vat',
      effectiveFrom: '2020-01-01' as LocalDate,
    },
  ]);
  (loaded.documents as Map<string, unknown>).set(RECEIPT, {
    id: RECEIPT,
    kind: documentKinds.receipt,
    schema: body.parserVersion,
    body,
    bodyHash: 'example',
    docDate: body.issueDate,
    partyId: SELLER,
    currency: 'RON',
    number: body.number,
    evidenceId: null,
  });
  (loaded.parties as Map<string, PartyRecord>).set(SELLER, {
    id: SELLER,
    kind: 'ro_legal_entity',
    country: 'RO',
    taxId: '29031773',
    name: body.seller.name,
  });
  for (const party of extra.parties ?? [])
    (loaded.parties as Map<string, PartyRecord>).set(party.id, party);
  (loaded.fxRates as Map<string, readonly FxRate[]>).set('EUR', extra.fx ?? [RATE]);
  for (const answer of extra.answers ?? [])
    (loaded.answers as Map<string, AnswerRecord>).set(answer.questionId, answer);
  extra.with?.(loaded);
  return loaded;
}

export const receiptIds = { receipt: RECEIPT, seller: SELLER, rate: RATE };

/** `receipts.recognize` on a receipt in `receiptLoaded`'s books. */
export function receiptEvaluation(
  register: ParameterRegister,
  loaded: Loaded,
  input: Record<string, unknown>,
): { evaluation: Evaluation; rules: RuleContext } {
  const rules = new RuleContext(register, 'preview');
  const evaluation = receiptRecognition.evaluate(
    receiptRecognitionInput.parse({ documentId: RECEIPT, payment: { method: 'card' }, ...input }),
    loaded,
    rules,
  );
  return { evaluation, rules };
}

const outcome = (
  evaluation: Evaluation,
  register: ParameterRegister,
  rules: RuleContext,
  summary: string,
): CaseOutcome => ({
  summary,
  lines: [
    ...evaluation.issues.map(
      (issue) =>
        `${issue.severity === 'block' ? 'Blocare' : issue.severity === 'ack' ? 'De confirmat' : 'Informare'} ${issue.code}: ${issue.message}`,
    ),
    ...[...rules.used.keys()].map((id) => {
      const version = register.versions.find((item) => item.id === id);
      return `Parametru ${id} = ${JSON.stringify(version?.value)}`;
    }),
  ],
});

/** What a receipt books, as a review case shows it: the VAT deducted, or why it is refused. */
function receiptCase(
  register: ParameterRegister,
  body: ReceiptDocument,
  input: Record<string, unknown>,
): CaseOutcome {
  const { evaluation, rules } = receiptEvaluation(register, receiptLoaded(body), input);
  const effect = evaluation.effect;
  const blocks = evaluation.issues.filter((issue) => issue.severity === 'block');
  return outcome(
    evaluation,
    register,
    rules,
    effect
      ? effect.taxEntries.length
        ? `Propus: factură simplificată, TVA dedusă ${lei(effect.taxEntries.reduce((sum, entry) => sum + entry.deductibleBani, 0n))} lei din ${lei(effect.taxEntries.reduce((sum, entry) => sum + entry.taxBani, 0n))} lei (${effect.taxEntries.map((entry) => entry.code).join(', ')})`
        : `Propus: cheltuială ${body.totals.gross} lei cu TVA inclusă, nededusă (bonul nu ține loc de factură simplificată)`
      : `Blocat: ${[...new Set(blocks.map((issue) => issue.code))].join(', ')}`,
  );
}

const RECEIPT_FACTS =
  'Companie înregistrată în scopuri de TVA (regim normal, lunar). Bon fiscal de motorină din 18.10.2026 (duminică), cota 21%, plătit cu cardul; cursul BNR al euro valabil la acea dată este cel din 16.10.2026, 5,0815 lei (100 euro = 508,15 lei).';

/** A receipt case: the engine reads the buyer's code as printed; the alternative reads a CUI
 * without the RO prefix as no VAT code at all, so the receipt is no simplified invoice. */
function codeCase(options: {
  title: string;
  facts: string;
  gross: string;
  tax: string;
  buyerTaxId: string | null;
}) {
  const strict = options.buyerTaxId && !/^RO/i.test(options.buyerTaxId) ? null : options.buyerTaxId;
  return {
    title: options.title,
    facts: `${RECEIPT_FACTS} ${options.facts}`,
    run: (register: ParameterRegister) => {
      const deducting = (code: string | null) =>
        receiptCase(register, fuelReceipt({ ...options, buyerTaxId: code }), {
          account: '6022',
          deduction: code === null ? 'none' : 'full',
        });
      return { engine: deducting(options.buyerTaxId), alternative: deducting(strict) };
    },
  };
}

export const simplifiedInvoiceSpec: ReviewSpec = {
  key: 'ro.vat.simplified_invoice.limit_eur',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 15,
  readings: {
    engine:
      'Bonul fiscal ține loc de factură simplificată, iar TVA de pe el se deduce în condițiile art. 297–299, dacă valoarea lui, cu TVA, este de cel mult 100 euro la cursul BNR valabil la data bonului (art. 319 alin. (12) lit. a), art. 290 alin. (2)) și aparatul de marcat a înscris codul companiei; codul fiscal tipărit fără prefixul RO al unei companii înregistrate în scopuri de TVA o identifică, iar persoana care aprobă confirmă bonul (RECEIPT_BUYER_CODE).',
    alternative:
      'Normele (pct. 69 alin. (3) și (6)) cer pe bon codul de înregistrare în scopuri de TVA al beneficiarului: un cod fiscal tipărit fără prefixul RO nu este acel cod, iar bonul justifică doar cheltuiala, cu TVA nededusă.',
  },
  question:
    'Un bon fiscal de cel mult 100 euro pe care aparatul de marcat a înscris codul fiscal al companiei plătitoare de TVA fără prefixul RO (de exemplu „CIF: 18547290”) justifică deducerea TVA?',
  context: [
    'ANAF/Cod-fiscal-consolidat:art.319(13)',
    'ANAF/Cod-fiscal-consolidat:art.319(21)',
    'ANAF/Cod-fiscal-consolidat:art.299(1)(a)',
    'ANAF/Cod-fiscal-consolidat:art.319(10)(a)',
  ],
  cases: [
    codeCase({
      title: 'Bon de 300,00 lei cu codul de TVA RO18547290',
      facts: 'Bonul înscrie „CIF CLIENT: RO18547290”; total 300,00 lei, TVA 52,07 lei.',
      gross: '300.00',
      tax: '52.07',
      buyerTaxId: 'RO18547290',
    }),
    codeCase({
      title: 'Bon de 300,00 lei cu codul fiscal 18547290, fără RO',
      facts: 'Bonul înscrie „CIF: 18547290”, fără prefixul RO; total 300,00 lei, TVA 52,07 lei.',
      gross: '300.00',
      tax: '52.07',
      buyerTaxId: '18547290',
    }),
    codeCase({
      title: 'Bon de 508,00 lei, sub limita de 508,15 lei',
      facts: 'Bonul înscrie RO18547290; total 508,00 lei, TVA 88,17 lei: 99,97 euro.',
      gross: '508.00',
      tax: '88.17',
      buyerTaxId: 'RO18547290',
    }),
    codeCase({
      title: 'Bon de 520,00 lei, peste limită',
      facts:
        'Bonul înscrie RO18547290; total 520,00 lei, TVA 90,25 lei: 102,33 euro, peste 100 euro.',
      gross: '520.00',
      tax: '90.25',
      buyerTaxId: 'RO18547290',
    }),
    codeCase({
      title: 'Bon de 300,00 lei fără codul companiei',
      facts: 'Bonul nu înscrie niciun cod al cumpărătorului; total 300,00 lei, TVA 52,07 lei.',
      gross: '300.00',
      tax: '52.07',
      buyerTaxId: null,
    }),
  ],
  gaps: [
    'Textul republicat al OUG nr. 28/1999 (aparatele de marcat, bonul cu codul cumpărătorului) nu este în .sources/: portalul legislativ refuză descărcarea automată, iar ANAF nu îl publică.',
    'Facturile simplificate între 100 și 400 euro (art. 319 alin. (13)) cer un ordin al ministrului pentru furnizor: motorul nu are cum să știe de un asemenea ordin și tratează bonul peste 100 euro ca nefiind factură simplificată.',
    'Cursul de referință este cel al BNR la data bonului (ro.fx.rate_date.vat); cursul BCE sau al băncii, pe care art. 290 alin. (2) le admite prin contract, nu este folosit.',
    'Bonul peste limită cu codul companiei: furnizorul emite factura (e-Factura); dacă ea sosește, înregistrarea bonului se stornează (RECEIPT_INVOICE_EXPECTED). Bonul și factura sunt documente de tipuri diferite și nu se pot lega în același grup de copii.',
    'Un bon fără codul companiei sau peste limită nu are intrare în jurnalul de TVA (nu este document pentru decont): dacă rândurile 24–25 ale D300 cuprind și achizițiile fără drept de deducere este întrebarea deschisă pentru facturi (ro.declaration D300).',
    'Pentru impozitul pe profit, TVA nededusă rămâne în cheltuială și urmează deductibilitatea ei (art. 25; pct. 16 alin. (3) din norme pentru vehicule): dacă un bon fără codul companiei justifică cheltuiala (cu decontul salariatului) nu este citit separat.',
  ],
};

// The domestic reverse charge.

/** A domestic invoice in category AE, by line: purchased when `purchase`, else supplied. */
export function reverseChargeInvoice(options: {
  issueDate: string;
  lines: { description: string; net: string }[];
  purchase?: boolean;
}): InvoiceDocument {
  const company = { name: 'Companie exemplu SRL', taxId: 'RO18547290', country: 'RO' };
  const partner = { name: 'Partener exemplu SRL', taxId: 'RO13548146', country: 'RO' };
  const total = options.lines
    .reduce((sum, line) => sum + BigInt(line.net.replace('.', '')), 0n)
    .toString()
    .padStart(3, '0');
  const net = `${total.slice(0, -2)}.${total.slice(-2)}`;
  return invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: 'invoice',
    number: 'TI-1',
    issueDate: options.issueDate,
    taxPointDate: null,
    currency: 'RON',
    supplier: options.purchase ? partner : company,
    customer: options.purchase ? company : partner,
    originalInvoiceNumber: null,
    customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1',
    lines: options.lines.map((line, index) => ({
      id: String(index + 1),
      description: line.description,
      net: line.net,
      vatCategory: 'AE',
      vatRate: '0',
    })),
    taxes: [{ base: net, tax: '0.00', category: 'AE', rate: '0', exemptionReason: 'VATEX-EU-AE' }],
    totals: {
      lineNet: net,
      net,
      tax: '0.00',
      gross: net,
      allowances: '0.00',
      charges: '0.00',
      prepaid: '0.00',
      rounding: '0.00',
      payable: net,
    },
  });
}

export const reverseChargeIds = { invoice: INVOICE, partner: SELLER };

/** `invoices.reverseCharge` on an AE invoice of a company registered for VAT. */
export function reverseChargeEvaluation(
  register: ParameterRegister,
  body: InvoiceDocument,
  input: Record<string, unknown>,
  status: 'normal_vat' | 'non_vat' = 'normal_vat',
): { evaluation: Evaluation; rules: RuleContext } {
  const loaded = emptyLoaded([
    { axis: 'vat.status', value: status, effectiveFrom: '2020-01-01' as LocalDate },
  ]);
  const purchase = body.customer.taxId === 'RO18547290';
  (loaded.documents as Map<string, unknown>).set(INVOICE, {
    id: INVOICE,
    kind: purchase ? invoiceKinds.purchase : invoiceKinds.sale,
    schema: 'invoice',
    body,
    bodyHash: 'example',
    docDate: body.issueDate,
    partyId: SELLER,
    currency: 'RON',
    number: body.number,
    evidenceId: null,
  });
  const rules = new RuleContext(register, 'preview');
  const evaluation = reverseChargeRecognition.evaluate(
    reverseChargeInput.parse({ documentId: INVOICE, ...input }),
    loaded,
    rules,
  );
  return { evaluation, rules };
}

const RC_FACTS =
  'Companie înregistrată în scopuri de TVA (regim normal, lunar) cumpără pe 10.10.2026 de la un furnizor înregistrat în scopuri de TVA, pe o singură factură cu mențiunea „taxare inversă” (categoria AE), bunurile de mai jos; cota standard 21%.';

/** A purchase case: the engine counts the threshold categories together on the invoice; the
 * alternative counts each category on its own. */
function thresholdCase(options: {
  title: string;
  facts: string;
  parts: {
    category: ReverseChargeCategory;
    account: string;
    amount: string;
    description: string;
  }[];
}) {
  return {
    title: options.title,
    facts: `${RC_FACTS} ${options.facts}`,
    run: (register: ParameterRegister) => {
      const body = reverseChargeInvoice({
        issueDate: '2026-10-10',
        purchase: true,
        lines: options.parts.map((part) => ({ description: part.description, net: part.amount })),
      });
      const parts = options.parts.map(({ description: _d, ...part }) => part);
      const { evaluation, rules } = reverseChargeEvaluation(register, body, { parts });
      const describe = (evaluated: Evaluation, context: RuleContext) => {
        const effect = evaluated.effect;
        const self = effect?.taxEntries
          .filter((entry) => entry.direction === 'output')
          .reduce((sum, entry) => sum + entry.taxBani, 0n);
        return outcome(
          evaluated,
          register,
          context,
          effect
            ? `Propus: taxare inversă, TVA autolichidată ${lei(self!)} lei (colectată și dedusă)`
            : `Blocat: ${[...new Set(evaluated.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code))].join(', ')}`,
        );
      };
      // Each category alone, as the alternative reads the threshold.
      const rule = rules.param<ReverseChargeRule>(
        'ro.vat.reverse_charge.domestic',
        'vat_chargeability_date',
        '2026-10-10' as LocalDate,
      );
      const alone = parts.every(
        (part) =>
          reverseChargeApplies(
            [{ category: part.category, bani: BigInt(part.amount.replace('.', '')) }],
            rule,
          ).applies,
      );
      const alternative = alone
        ? describe(evaluation, rules)
        : {
            summary: 'Blocat: REVERSE_CHARGE_THRESHOLD (fiecare categorie sub 22.500 lei)',
            lines: describe(evaluation, rules).lines.filter((line) => line.startsWith('Parametru')),
          };
      return { engine: describe(evaluation, rules), alternative };
    },
  };
}

export const reverseChargeSpec: ReviewSpec = {
  key: 'ro.vat.reverse_charge.domestic',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 15,
  readings: {
    engine:
      'Taxarea inversă internă se aplică categoriilor art. 331 alin. (2) în vigoare la data exigibilității (pentru lit. c)–f) și i)–l) până la 31.12.2026, alin. (6)); telefoanele mobile, circuitele integrate, consolele, tabletele și laptopurile de pe aceeași factură se însumează pentru pragul de 22.500 lei fără TVA (alin. (7), norme pct. 109 alin. (19)).',
    alternative:
      'Pragul de 22.500 lei se aplică fiecărei categorii de la lit. i), j) și k) separat: o factură cu telefoane, console și circuite integrate, fiecare sub prag, se taxează normal.',
  },
  question:
    'Pe o factură cu telefoane mobile (7.900 lei), console (9.000 lei) și circuite integrate (5.800 lei), se aplică taxarea inversă tuturor (22.700 lei împreună), cum arată exemplul din norme, sau niciuneia (fiecare sub 22.500 lei)?',
  context: [
    'ANAF/Cod-fiscal-consolidat:norme.art.331.pct.109(1)',
    'ANAF/Cod-fiscal-consolidat:norme.art.331.pct.109(4)',
    'ANAF/Cod-fiscal-consolidat:norme.art.331.pct.109(7)',
  ],
  cases: [
    thresholdCase({
      title: 'Telefoane, console și circuite integrate, 22.700 lei împreună',
      facts:
        'Telefoane mobile 7.900 lei, console de jocuri 9.000 lei și circuite integrate 5.800 lei, pe cheltuieli (6028).',
      parts: [
        {
          category: 'mobile_phones',
          account: '6028',
          amount: '7900.00',
          description: 'Telefoane mobile',
        },
        {
          category: 'consoles_tablets_laptops',
          account: '6028',
          amount: '9000.00',
          description: 'Console de jocuri',
        },
        {
          category: 'integrated_circuits',
          account: '6028',
          amount: '5800.00',
          description: 'Microprocesoare',
        },
      ],
    }),
    thresholdCase({
      title: 'Laptopuri de 30.000 lei',
      facts: 'Laptopuri de 30.000 lei fără TVA, pe cheltuieli (6028).',
      parts: [
        {
          category: 'consoles_tablets_laptops',
          account: '6028',
          amount: '30000.00',
          description: 'Laptopuri',
        },
      ],
    }),
    thresholdCase({
      title: 'Telefoane mobile de 20.000 lei',
      facts: 'Telefoane mobile de 20.000 lei fără TVA, sub prag.',
      parts: [
        {
          category: 'mobile_phones',
          account: '6028',
          amount: '20000.00',
          description: 'Telefoane mobile',
        },
      ],
    }),
    thresholdCase({
      title: 'Deșeuri de hârtie de 1.000 lei',
      facts: 'Deșeuri de hârtie și carton de 1.000 lei, fără prag.',
      parts: [
        { category: 'waste', account: '6028', amount: '1000.00', description: 'Deșeuri de hârtie' },
      ],
    }),
  ],
  gaps: [
    'Facturile care amestecă bunuri cu taxare inversă și bunuri taxate normal (exemplul din norme pct. 109 alin. (19), imprimante și camere video) sunt refuzate (REVERSE_CHARGE_MIXED): partea taxată normal nu este încă înregistrată pe aceeași factură.',
    'Din 2027 lit. c)–f) și i)–l) nu se mai aplică (alin. (6)), afară de o prelungire: versiunea parametrului se încheie la 31.12.2026, iar 2027 este o lacună până la actele din decembrie (docs/ROLLOVER.md).',
    'Bunurile care cer stocuri (deșeuri, masă lemnoasă, cereale, aur, telefoane, electronice) se înregistrează fără mișcări de stoc, până la modulul de stocuri (G1).',
    'Condiția de comerciant pentru energie electrică și gaze naturale (lista ANAF a declarațiilor 089) și temeiul taxării construcțiilor și terenurilor (prin lege sau opțiune, art. 292) sunt confirmate de persoana care aprobă, nu citite din registre.',
    'Facturile în valută, notele de credit și avansurile cu taxare inversă nu sunt încă acoperite.',
  ],
};
