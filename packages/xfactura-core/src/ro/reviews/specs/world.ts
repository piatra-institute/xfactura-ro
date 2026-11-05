import {
  turnoverKey,
  type AccountTurnover,
  type AnswerRecord,
  type Evaluation,
  type Issue,
  type Loaded,
  type ProfileFact,
} from '../../../kernel';
import { divRound, parseMoney, parseScaled } from '../../../money';
import { normalizePlate, type VehicleUseAnswer } from '../../../questions/kinds';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../../ubl/invoice-document';
import { invoiceKinds, invoiceRecognition, recognitionInput } from '../../treatments/invoices';
import { microQuarterRange, microTax, microTaxInput } from '../../treatments/micro-tax';
import type { CaseOutcome } from '../types';

/**
 * Small, fixed worlds the review specs' cases run the engine's own treatments in. Nothing here
 * computes a tax: the treatments do, against the register under review.
 */

const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
const SUPPLIER = '00000000-0000-4000-8000-0000000000c2';
const AUTHORITY = '00000000-0000-4000-8000-0000000000a1';
const TRANSFERS = '00000000-0000-4000-8000-0000000000e1';

/** Amounts as a Romanian reader writes them: 1.234,56. */
export function lei(bani: bigint): string {
  const negative = bani < 0n;
  const digits = (negative ? -bani : bani).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${whole},${digits.slice(-2)}`;
}
const ron = (text: string) => parseMoney(text, 'RON');

export function emptyLoaded(profile: ProfileFact[]): Loaded {
  return {
    years: [],
    evidence: new Map(),
    documents: new Map(),
    entries: new Map(),
    openItems: new Map(),
    movements: new Map(),
    parties: new Map(),
    profile,
    fxRates: new Map(),
    balances: [],
    taxLedger: new Map(),
    payrollRuns: new Map(),
    turnover: new Map(),
    itemLines: new Map(),
    assets: new Map(),
    profitPostings: [],
    partyStatus: new Map(),
    answers: new Map(),
    stock: new Map(),
    stockItems: new Map(),
    warehouses: new Map(),
  };
}

const issueLines = (issues: readonly Issue[]) =>
  issues.map(
    (issue) =>
      `${issue.severity === 'block' ? 'Blocare' : issue.severity === 'ack' ? 'De confirmat' : 'Informare'} ${issue.code}: ${issue.message}`,
  );
const parameterLines = (register: ParameterRegister, rules: RuleContext) =>
  [...rules.used.keys()].map((id) => {
    const version = register.versions.find((item) => item.id === id);
    return `Parametru ${id} = ${JSON.stringify(version?.value)}`;
  });

/** A domestic sale of services in lei by a VAT payer, one category of VAT. */
export function saleInvoice(options: {
  issueDate: string;
  taxPointDate?: string;
  /** BT-72, the supply's date the invoice states. */
  deliveryDate?: string;
  /** BG-14, the period invoiced. */
  invoicePeriod?: { start: string; end: string };
  net: string;
  rate: string;
}): InvoiceDocument {
  const tax = divRound(
    ron(options.net) * parseScaled(options.rate, 4),
    1_000_000n,
    'halfAwayFromZero',
  );
  const net = ron(options.net);
  const text = (bani: bigint) => `${bani / 100n}.${String(bani % 100n).padStart(2, '0')}`;
  return invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: 'invoice',
    number: 'EX-1',
    issueDate: options.issueDate,
    taxPointDate: options.taxPointDate ?? null,
    ...(options.deliveryDate ? { deliveryDate: options.deliveryDate } : {}),
    ...(options.invoicePeriod ? { invoicePeriod: options.invoicePeriod } : {}),
    currency: 'RON',
    supplier: { name: 'Companie exemplu SRL', taxId: 'RO100', country: 'RO' },
    customer: { name: 'Client exemplu', taxId: 'RO200', country: 'RO' },
    originalInvoiceNumber: null,
    customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1',
    lines: [
      {
        id: '1',
        description: 'Operațiune',
        net: text(net),
        vatCategory: 'S',
        vatRate: options.rate,
      },
    ],
    taxes: [
      { base: text(net), tax: text(tax), category: 'S', rate: options.rate, exemptionReason: null },
    ],
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

/** `invoices.recognize` on a sale, for a company registered for VAT (normal regime, monthly). */
export function recognizeSale(register: ParameterRegister, body: InvoiceDocument): CaseOutcome {
  const loaded = emptyLoaded([
    { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
  ]);
  (loaded.documents as Map<string, unknown>).set(DOCUMENT, {
    id: DOCUMENT,
    kind: invoiceKinds.sale,
    schema: 'invoice',
    body,
    bodyHash: 'example',
    docDate: body.issueDate,
    partyId: CUSTOMER,
    currency: 'RON',
    number: body.number,
    evidenceId: null,
  });
  const rules = new RuleContext(register, 'preview');
  const evaluation = invoiceRecognition.evaluate(
    recognitionInput.parse({ documentId: DOCUMENT, account: '704' }),
    loaded,
    rules,
  );
  return describe(evaluation, register, rules, (effect) => {
    const entry = effect.taxEntries[0]!;
    return `Propus: TVA colectată ${lei(entry.taxBani)} lei (${entry.code}), perioada TVA ${entry.taxPeriod}`;
  });
}

/** A domestic purchase in lei from a VAT payer, its one line described as given. */
export function purchaseInvoice(options: {
  issueDate: string;
  net: string;
  rate: string;
  description: string;
}): InvoiceDocument {
  const body = saleInvoice({ issueDate: options.issueDate, net: options.net, rate: options.rate });
  return invoiceDocumentSchema.parse({
    ...body,
    supplier: body.customer,
    customer: body.supplier,
    lines: body.lines.map((line) => ({ ...line, description: options.description })),
  });
}

/** A person's answer about a vehicle, as a proposal's basis would cite it. */
export function vehicleAnswerRecord(
  plate: string,
  value: VehicleUseAnswer,
  at = '2026-01-02T08:00:00.000Z',
): AnswerRecord {
  return {
    questionId: `vehicle.use/${normalizePlate(plate)}`,
    answerId: `${normalizePlate(plate)}@${at}`,
    kind: 'vehicle.use',
    subject: { kind: 'vehicle', id: plate },
    params: {},
    value: value as AnswerRecord['value'],
    evidenceId: '00000000-0000-4000-8000-0000000000e2',
    answeredAt: at,
  };
}

/** `invoices.recognize` on a purchase, for a company registered for VAT (normal regime,
 * monthly), with the answers the proposal's basis cites. */
export function purchaseEvaluation(
  register: ParameterRegister,
  body: InvoiceDocument,
  input: Record<string, unknown>,
  answers: readonly AnswerRecord[] = [],
) {
  const loaded = emptyLoaded([
    { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
  ]);
  (loaded.documents as Map<string, unknown>).set(DOCUMENT, {
    id: DOCUMENT,
    kind: invoiceKinds.purchase,
    schema: 'invoice',
    body,
    bodyHash: 'example',
    docDate: body.issueDate,
    partyId: SUPPLIER,
    currency: 'RON',
    number: body.number,
    evidenceId: null,
  });
  for (const answer of answers)
    (loaded.answers as Map<string, AnswerRecord>).set(answer.questionId, answer);
  const rules = new RuleContext(register, 'preview');
  const evaluation = invoiceRecognition.evaluate(
    recognitionInput.parse({ documentId: DOCUMENT, ...input }),
    loaded,
    rules,
  );
  return { evaluation, rules };
}

/** `purchaseEvaluation`, as a review case shows it: the VAT deducted of the VAT invoiced. */
export function recognizePurchase(
  register: ParameterRegister,
  body: InvoiceDocument,
  input: Record<string, unknown>,
  answers: readonly AnswerRecord[] = [],
): CaseOutcome {
  const { evaluation, rules } = purchaseEvaluation(register, body, input, answers);
  return describe(evaluation, register, rules, (effect) => {
    const entry = effect.taxEntries[0]!;
    return `Propus: TVA dedusă ${lei(entry.deductibleBani)} lei din ${lei(entry.taxBani)} lei (${entry.code})`;
  });
}

function describe(
  evaluation: Evaluation,
  register: ParameterRegister,
  rules: RuleContext,
  summary: (effect: NonNullable<Evaluation['effect']>) => string,
): CaseOutcome {
  const blocks = evaluation.issues.filter((issue) => issue.severity === 'block');
  return {
    summary: evaluation.effect
      ? summary(evaluation.effect)
      : `Blocat: ${[...new Set(blocks.map((issue) => issue.code))].join(', ')}`,
    lines: [...issueLines(evaluation.issues), ...parameterLines(register, rules)],
  };
}

/** A micro-enterprise's quarter: its revenue by account and the year's, to the quarter's end. */
export interface MicroQuarter {
  quarter: string;
  /** Revenue posted in the quarter, by account, in lei. */
  quarterRevenue: Record<string, string>;
  /** Revenue from the year's start to the quarter's end, by account, in lei. */
  yearRevenue: Record<string, string>;
  /** The BNR EUR rate at the previous year's end. */
  eurRate: string;
  microFrom?: string;
  /** The year's transfers of fixed assets and land, as the reviewer states them. */
  assetTransfers?: {
    subgroups: { subgroup: string; count: number; revenue: string }[];
    land?: { count: number; revenue: string };
  };
}

const turnoverRows = (revenue: Record<string, string>): AccountTurnover[] =>
  Object.entries(revenue).map(([account, amount]) => ({
    account,
    debit: 0n,
    credit: ron(amount),
  }));

export function microLoaded(world: MicroQuarter): Loaded {
  const range = microQuarterRange(world.quarter);
  const loaded = emptyLoaded([
    {
      axis: 'income_tax',
      value: 'micro',
      effectiveFrom: (world.microFrom ?? `${range.year}-01-01`) as LocalDate,
    },
  ]);
  (loaded.parties as Map<string, unknown>).set(AUTHORITY, {
    id: AUTHORITY,
    kind: 'ro_public_institution',
    country: 'RO',
    taxId: '4221306',
    name: 'ANAF',
  });
  if (world.assetTransfers)
    (loaded.evidence as Map<string, unknown>).set(TRANSFERS, {
      id: TRANSFERS,
      filename: 'transferuri.pdf',
    });
  (loaded.fxRates as Map<string, unknown>).set('EUR', [
    {
      id: 'eur',
      source: 'BNR',
      currency: 'EUR',
      date: range.before,
      rate: world.eurRate,
      multiplier: 1,
    },
  ]);
  const turnover = loaded.turnover as Map<string, AccountTurnover[]>;
  turnover.set(
    turnoverKey({ prefixes: ['6', '7'], from: range.from, to: range.to }),
    turnoverRows(world.quarterRevenue),
  );
  turnover.set(
    turnoverKey({ prefixes: ['6', '7'], from: range.yearStart, to: range.to }),
    turnoverRows(world.yearRevenue),
  );
  return loaded;
}

/** `tax.micro` on the quarter, posted on its last day: the evaluation and the rules it used. */
export function microEvaluation(register: ParameterRegister, world: MicroQuarter) {
  const range = microQuarterRange(world.quarter);
  const rules = new RuleContext(register, 'preview');
  const evaluation = microTax.evaluate(
    microTaxInput.parse({
      quarter: world.quarter,
      date: range.to,
      authorityId: AUTHORITY,
      ...(world.assetTransfers
        ? { assetTransfers: { ...world.assetTransfers, evidenceId: TRANSFERS } }
        : {}),
    }),
    microLoaded(world),
    rules,
  );
  return { evaluation, rules };
}

/** `tax.micro` on the quarter, posted on its last day. */
export function microQuarterTax(register: ParameterRegister, world: MicroQuarter): CaseOutcome {
  const { evaluation, rules } = microEvaluation(register, world);
  return describe(evaluation, register, rules, (effect) => {
    const details = effect.explanation.details as { base: string; rate: string };
    return `Propus: impozit ${lei(effect.lines[0]!.bani)} lei pe baza de ${lei(ron(details.base))} lei (cota ${details.rate}%)`;
  });
}

/** The register's micro rate for the quarter, or the gap the engine would report. */
export function microRate(register: ParameterRegister, quarter: string) {
  try {
    return new RuleContext(register, 'preview').param<string>(
      'ro.micro.rate',
      'reporting_period_start',
      microQuarterRange(quarter).from,
    );
  } catch (error) {
    if (error instanceof RuleGapError) return error;
    throw error;
  }
}
