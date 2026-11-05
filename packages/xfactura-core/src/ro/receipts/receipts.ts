import { z } from 'zod';
import {
  accountCodePattern,
  partyStatusKey,
  profileAt,
  turnoverKey,
  vatPeriodOf,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type ReadPlan,
  type TaxEntrySpec,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import {
  allocate,
  divRound,
  formatMoney,
  LEDGER_CURRENCY,
  parseMoney,
  parseScaled,
} from '../../money';
import { normalizePlate, questionIssue } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import {
  documentKinds,
  receiptDocumentSchema,
  type ReceiptDocument,
} from '../../documents/schemas';
import { selectRate } from '../fx';
import type { CashLimits } from '../treatments/cash';
import { registration } from '../treatments/invoices';
import {
  answerCovers,
  suggestsVehicle,
  VEHICLE_CLAUSES,
  vehicleAnswer,
  vehicleDeduction,
  vehicleSubject,
} from '../vehicles';

/*
 * A fiscal receipt (bon fiscal) a company paid for. A receipt is a simplified invoice, whose VAT
 * the company may deduct under the usual conditions (art. 297–299), only when the cash register
 * printed the company's VAT code on it and its value, VAT included, is at most the limit of art.
 * 319 alin. (12) lit. a) (100 euro at the rate of art. 290 alin. (2) on its date): the norms'
 * pct. 69 alin. (3) and (6). Otherwise it justifies the expense and its VAT stays in the
 * expense. Its payment is booked with it, so one receipt is one entry: from the cash desk
 * (531x), or by card (a payable the bank movement settles, `bank.settle`), or by an employee,
 * from an advance (542) or their own money (owed to them on 542 until repaid).
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
export const RECEIPT_CLAUSES = [
  `${CODE}:art.319(12)`,
  `${CODE}:art.319(21)`,
  `${CODE}:norme.art.299.pct.69(3),(6)`,
  `${CODE}:art.290(2)`,
];
const INACTIVE_CLAUSE = `${CODE}:art.11(7)`;
/** The profit tax of a receipt's VAT not deducted: part of the expense, deductible when the
 * expense is (art. 25), with a vehicle's 50% limit applied to it too (norme pct. 16 alin. (3)). */
const PROFIT_CLAUSE = `${CODE}:norme.art.25.pct.16`;

const block = (
  code: string,
  message: string,
  path?: string,
  details?: Issue['details'],
): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const warn = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);

const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const rate = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);
const deduction = z.enum(['full', 'none', 'limited']);

/** How a receipt was paid, which is booked with it. */
export const receiptPayment = z.discriminatedUnion('method', [
  /** From the company's cash desk: the receipt's number enters the cash register. */
  z.object({ method: z.literal('cash'), account: z.string().regex(/^531\d?$/) }).strict(),
  /** With the company's card: a payable of the seller, settled by the bank movement. */
  z.object({ method: z.literal('card') }).strict(),
  /** By an employee from an advance for expenses (542), justified by the expense report. */
  z.object({ method: z.literal('advance'), advanceId: z.uuid() }).strict(),
  /** By an employee from their own money: owed to them on 542 until repaid (cash or bank). */
  z.object({ method: z.literal('employee'), partyId: z.uuid() }).strict(),
]);
export type ReceiptPayment = z.infer<typeof receiptPayment>;

export const receiptRecognitionInput = z
  .object({
    documentId: z.uuid(),
    /** Every rate's amount on one expense account (6xx). */
    account: z.string().regex(accountCodePattern).optional(),
    /** What the company may deduct of the VAT when the receipt is a simplified invoice: `limited`
     * for a road vehicle not used only for the business (art. 298). */
    deduction: deduction.default('full'),
    /** The road vehicle the expense concerns (its registration): what it deducts follows the
     * person's answer about the vehicle's use (`vehicle.use`, art. 298). */
    vehicle: registration.optional(),
    /** Instead of `account`: each VAT rate's amount, VAT included, split over accounts. */
    allocations: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            rate,
            /** With VAT, as the receipt prints it. */
            amount: money,
            deduction: deduction.default('full'),
            vehicle: registration.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional(),
    payment: receiptPayment,
    /** The expense report (decont) an employee's receipt is justified with. */
    reportEvidenceId: z.uuid().optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
  })
  .refine((input) => input.vehicle === undefined || input.allocations === undefined, {
    message:
      'Cu repartizarea pe conturi, vehiculul se indică pe fiecare parte (allocations.vehicle).',
    path: ['vehicle'],
  });
export type ReceiptRecognitionInput = z.infer<typeof receiptRecognitionInput>;

/** Why a receipt is not a simplified invoice, when it is not. */
export type ReceiptQualification =
  | { simplified: true; limit: { eur: string; rate: FxRate; lei: string }; vatCode: boolean }
  | {
      simplified: false;
      reason: 'non_payer' | 'no_buyer_code' | 'over_limit';
      limit?: { eur: string; rate: FxRate; lei: string };
    };

/** Whether a receipt's buyer code is printed as a VAT code (with the RO prefix). */
const printedAsVatCode = (buyerTaxId: string) => /^RO/i.test(buyerTaxId.replace(/\s+/g, ''));

const always = '1900-01-01' as LocalDate;
const cashQuery = (account: string, date: LocalDate): TurnoverQuery => ({
  prefixes: [account],
  from: always,
  to: date,
});

function receiptOf(loaded: Loaded, id: string) {
  const record = loaded.documents.get(id);
  if (!record) return block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId');
  if (record.kind !== documentKinds.receipt)
    return block(
      'DOCUMENT_KIND',
      'Tratamentul înregistrează bonuri fiscale; o factură se înregistrează cu invoices.recognize.',
      'documentId',
    );
  return { record, body: receiptDocumentSchema.parse(record.body) };
}

/**
 * Whether a receipt is a simplified invoice of a company registered for VAT: the company's VAT
 * code on it (its CUI, the recording having checked it is the company's), and its value, VAT
 * included, at most the limit at the BNR rate of the receipt's date (art. 290 alin. (2): the
 * rate valid at the tax's exigibility, a retail supply's date). Only a payer reads the limit.
 */
export function receiptQualification(
  body: ReceiptDocument,
  loaded: Loaded,
  rules: RuleContext,
  status: string | null,
): ReceiptQualification | Issue {
  if (status === 'non_vat') return { simplified: false, reason: 'non_payer' };
  if (!body.buyerTaxId) return { simplified: false, reason: 'no_buyer_code' };
  const date = body.issueDate as LocalDate;
  let eur: string;
  try {
    eur = rules.param<string>(
      'ro.vat.simplified_invoice.limit_eur',
      'vat_chargeability_date',
      date,
    );
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return block('RULE_GAP', error.message);
  }
  const selected = selectRate(loaded, rules, 'EUR', date, 'vat');
  if ('code' in selected) return selected;
  // gross ≤ limit × rate ÷ multiplier, in bani: gross × multiplier × 10^8 ≤ limit × 100 × rate × 10^8.
  const rateUnits = parseScaled(selected.rate, 8);
  const ceiling = BigInt(eur) * 100n * rateUnits;
  const gross = ron(body.totals.gross) * BigInt(selected.multiplier) * 100_000_000n;
  const limit = {
    eur,
    rate: selected,
    lei: lei(ceiling / (100_000_000n * BigInt(selected.multiplier))),
  };
  return gross <= ceiling
    ? { simplified: true, limit, vatCode: printedAsVatCode(body.buyerTaxId) }
    : { simplified: false, reason: 'over_limit', limit };
}

type Part = {
  account: string;
  rate: string;
  gross: bigint;
  deduction: 'full' | 'none' | 'limited';
  vehicle?: string;
  /** `allocations.<n>`, or null for the input's single account. */
  path: string | null;
};
/** Where a part's field is in the input. */
const at = (part: Part, field: 'account' | 'deduction' | 'vehicle') =>
  part.path === null ? field : `${part.path}.${field}`;

/** What a vehicle's answer decided for a receipt, as the explanation shows it. */
type VehicleDecision = {
  vehicle: string;
  use: 'business_only' | 'mixed';
  from: string;
  exception: string | null;
  deduction: 'full' | 'limited';
  questionId: string;
  answerId: string;
  evidence: string[];
};

/** Art. 298 on a receipt's deducting parts, as `invoices.recognize` applies it: a named vehicle
 * deducts what its answer allows (`VEHICLE_USE`, `VEHICLE_DEDUCTION`); an unnamed one on a
 * vehicle's account, or a limited share without a vehicle, is confirmed (`VEHICLE_UNNAMED`). */
function vehicleIssues(
  parts: readonly Part[],
  body: ReceiptDocument,
  documentId: string,
  loaded: Loaded,
  taxPoint: LocalDate,
): { issues: Issue[]; decided: VehicleDecision[] } {
  const issues: Issue[] = [];
  const decided: VehicleDecision[] = [];
  const lines = body.lines.map((line) => line.description);
  const named = new Map<string, Part[]>();
  const unnamed = new Set<string>();
  for (const part of parts) {
    if (part.deduction === 'none') continue;
    if (part.vehicle === undefined) {
      if (part.deduction === 'limited' || suggestsVehicle(part.account, lines))
        unnamed.add(part.account);
      continue;
    }
    const plate = normalizePlate(part.vehicle);
    named.set(plate, [...(named.get(plate) ?? []), part]);
  }
  if (unnamed.size)
    issues.push(
      warn(
        'VEHICLE_UNNAMED',
        `Bonul pare să privească un vehicul rutier (contul ${[...unnamed].join(', ')} sau produsele de pe bon), ori deduce TVA limitat, fără să numească vehiculul. Indicați numărul lui de înmatriculare (vehicle), ca deducerea să urmeze răspunsul despre folosirea lui (art. 298 din Codul fiscal), sau confirmați deducerea aleasă.`,
        { accounts: [...unnamed], clauses: VEHICLE_CLAUSES },
      ),
    );
  for (const [plate, members] of named) {
    const found = vehicleAnswer(loaded, plate);
    if (!found || !answerCovers(found.value, taxPoint)) {
      issues.push(
        questionIssue(
          'VEHICLE_USE',
          found
            ? `Răspunsul despre vehiculul ${plate} privește folosirea lui de la ${found.value.from}, după data bonului (${taxPoint}): proprietarul spune cum era folosit la acea dată, iar propunerea se revizuiește citând răspunsul.`
            : `Bonul privește vehiculul ${plate}: TVA se deduce integral doar dacă vehiculul este folosit exclusiv în scopul activității economice, cu foaia de parcurs, sau dacă art. 298 nu îl limitează; altfel 50%. Întrebați proprietarul (vehicle.use) și revizuiți propunerea citând răspunsul.`,
          {
            kind: 'vehicle.use',
            subject: vehicleSubject(plate),
            params: { documentId, date: taxPoint },
          },
          'block',
          at(members[0]!, 'vehicle'),
        ),
      );
      continue;
    }
    const allowed = vehicleDeduction(found.value);
    const answer = { questionId: found.record.questionId, answerId: found.record.answerId };
    for (const part of members)
      if (part.deduction !== allowed)
        issues.push(
          block(
            'VEHICLE_DEDUCTION',
            `După răspunsul despre vehiculul ${plate} (${found.value.exception ? `exceptat de la limitare: ${found.value.exception}` : found.value.use === 'business_only' ? 'folosit exclusiv în scopul activității economice' : 'folosit și în alte scopuri'}, de la ${found.value.from}), TVA se deduce ${allowed === 'full' ? 'integral (deduction: full)' : 'limitat, în proporția de la art. 298 (deduction: limited)'}.`,
            at(part, 'deduction'),
            { vehicle: plate, allowed, ...answer, clauses: VEHICLE_CLAUSES },
          ),
        );
    decided.push({
      vehicle: plate,
      use: found.value.use,
      from: found.value.from,
      exception: found.value.exception ?? null,
      deduction: allowed,
      ...answer,
      evidence: [
        found.record.evidenceId,
        ...(found.value.logEvidenceId ? [found.value.logEvidenceId] : []),
        ...(found.value.exceptionEvidenceId ? [found.value.exceptionEvidenceId] : []),
      ],
    });
  }
  return { issues, decided };
}

/** A rate's VAT allowed on a receipt: the standard one, or the reduced one the reviewer confirms
 * the supply qualifies for (art. 291 alin. (2)); 0 for a line without VAT. */
function rateIssues(rates: readonly string[], rules: RuleContext, date: LocalDate): Issue[] {
  const issues: Issue[] = [];
  const read = (key: string, scope?: Record<string, string>) => {
    try {
      return rules.param<string>(key, 'vat_chargeability_date', date, scope);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      issues.push(block('RULE_GAP', error.message));
      return null;
    }
  };
  const taxed = rates.filter((value) => value !== '0');
  if (!taxed.length) return issues;
  const standard = read('ro.vat.rate', { category: 'S' });
  const other = taxed.filter((value) => value !== standard);
  if (!other.length || standard === null) return issues;
  const reduced = read('ro.vat.rate.reduced');
  for (const value of new Set(other))
    issues.push(
      value === reduced
        ? warn(
            'REDUCED_RATE',
            `Cota redusă de ${reduced}% se aplică doar livrărilor și prestărilor de la art. 291 alin. (2) din Codul fiscal: confirmați că produsele de pe bon se încadrează.`,
          )
        : block(
            'VAT_RATE',
            `Cota de pe bon (${value}%) diferă de cotele în vigoare la ${date} (${standard}%${reduced ? `, ${reduced}%` : ''}).`,
          ),
    );
  return issues;
}

/**
 * Recognizes a fiscal receipt: the expense on 6xx, the VAT it deducts when it is a simplified
 * invoice of a VAT payer (`receiptQualification`), at each of its rates, and its payment. The
 * deduction asked for is refused when the receipt cannot justify it (`DEDUCTION`): a non-payer,
 * a receipt without the company's code, one over the limit. Fuel and a vehicle's other costs
 * follow the answer about the vehicle's use (art. 298). A deductible receipt's VAT is a tax entry
 * at its rate (`S-<rate>`, `simplified: receipt`): D300 rows 24–25 and 31, D394's rezumat2
 * (bazaBFAI, TVABFAI). A receipt that is no simplified invoice records no tax entry: it is no
 * document for the VAT return, and its VAT is part of the expense for the profit tax too.
 */
export const receiptRecognition: Treatment<ReceiptRecognitionInput> = {
  id: 'receipts.recognize',
  version: 1,
  description:
    'Bon fiscal: cheltuiala, TVA dedusă când bonul ține loc de factură simplificată (codul de TVA al companiei, cel mult 100 euro) și plata lui din casierie, cu cardul sau de un salariat.',
  input: receiptRecognitionInput,
  agent: true,
  summary:
    'Fiscal receipt: the expense, the VAT it deducts as a simplified invoice (the company code on it, up to 100 euro), and its payment by cash, card or an employee.',
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId],
    profile: true,
    evidence: input.reportEvidenceId ? [input.reportEvidenceId] : [],
    ...(input.payment.method === 'advance'
      ? { openItems: [{ ids: [input.payment.advanceId] }] }
      : {}),
    ...(input.payment.method === 'employee' ? { parties: [input.payment.partyId] } : {}),
  }),
  followUp(input, loaded) {
    const record = loaded.documents.get(input.documentId);
    const parsed = receiptDocumentSchema.safeParse(record?.body);
    if (!record || !parsed.success) return null;
    const date = parsed.data.issueDate as LocalDate;
    const plan: ReadPlan = {};
    // The euro rate the limit is read at, only when the receipt carries the buyer's code.
    if (parsed.data.buyerTaxId) plan.fx = [{ currency: 'EUR', until: date }];
    if (record.partyId) {
      plan.parties = [record.partyId];
      if (parsed.data.seller.country === 'RO')
        plan.partyStatus = [{ partyId: record.partyId, date }];
    }
    if (input.payment.method === 'cash') plan.turnover = [cashQuery(input.payment.account, date)];
    return plan;
  },
  evaluate(input, loaded, rules) {
    const receipt = receiptOf(loaded, input.documentId);
    if ('code' in receipt) return { effect: null, issues: [receipt] };
    const { record, body } = receipt;
    const issues: Issue[] = [];
    const taxPoint = body.issueDate as LocalDate;
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    if (body.currency !== LEDGER_CURRENCY)
      issues.push(
        block(
          'CURRENCY',
          `Bonurile în ${body.currency} nu sunt încă acoperite: doar bonurile în lei.`,
        ),
      );
    if (!record.partyId) issues.push(block('PARTY', 'Bonul nu are vânzătorul ca partener.'));
    // Without the cash register's id, a second photo of the same receipt is not recognized as
    // one (documents.record identifies a receipt by seller, register, number and date).
    if (!body.register)
      issues.push(
        warn(
          'RECEIPT_IDENTITY',
          `Bonul ${body.number} nu indică aparatul de marcat (ID unic sau seria AMEF): o altă copie a lui nu poate fi recunoscută ca duplicat. Confirmați că nu este înregistrat deja.`,
        ),
      );
    const status = profileAt(loaded, 'vat.status', taxPoint);
    if (!status)
      issues.push(
        questionIssue(
          'DETERMINATION_MISSING',
          'Înregistrați regimul TVA al companiei pentru această dată.',
          {
            kind: 'profile.fact',
            subject: { kind: 'profile', id: 'vat.status' },
            params: { axis: 'vat.status', from: taxPoint },
          },
        ),
      );

    // The parts: one per rate on the account, or the allocations, each with VAT included.
    const taxes = body.taxes.map((tax) => ({
      rate: tax.rate,
      gross: ron(tax.gross),
      tax: ron(tax.tax),
    }));
    const parts: Part[] = input.allocations
      ? input.allocations.map((part, index) => ({
          account: part.account,
          rate: part.rate,
          gross: ron(part.amount),
          deduction: part.deduction,
          ...(part.vehicle === undefined ? {} : { vehicle: part.vehicle }),
          path: `allocations.${index}`,
        }))
      : taxes.map((tax) => ({
          account: input.account!,
          rate: tax.rate,
          gross: tax.gross,
          deduction: input.deduction,
          ...(input.vehicle === undefined ? {} : { vehicle: input.vehicle }),
          path: null,
        }));
    for (const part of parts)
      if (!/^6/.test(part.account))
        issues.push(block('ACCOUNT', 'Folosiți un cont de cheltuieli (6xx).', at(part, 'account')));
    if (input.allocations) {
      for (const part of parts)
        if (!taxes.some((tax) => tax.rate === part.rate))
          issues.push(block('ALLOCATION', `Bonul nu are cota ${part.rate}%.`, part.path!));
      for (const tax of taxes) {
        const allocated = parts
          .filter((part) => part.rate === tax.rate)
          .reduce((sum, part) => sum + part.gross, 0n);
        if (allocated !== tax.gross)
          issues.push(
            block(
              'ALLOCATION',
              `Cota ${tax.rate}% totalizează ${lei(tax.gross)} lei pe bon; repartizarea însumează ${lei(allocated)} lei.`,
              'allocations',
            ),
          );
      }
    }

    // Is it a simplified invoice? Only a payer's receipt with its code, within the limit.
    const qualification = status ? receiptQualification(body, loaded, rules, status) : null;
    if (qualification && 'code' in qualification) issues.push(qualification);
    const outcome = qualification && !('code' in qualification) ? qualification : null;
    const simplified = outcome?.simplified === true;
    const deducts = parts.some((part) => part.deduction !== 'none');
    if (outcome && !outcome.simplified && deducts)
      issues.push(
        block(
          'DEDUCTION',
          outcome.reason === 'non_payer'
            ? 'Un neplătitor de TVA nu deduce TVA: deduction: none.'
            : outcome.reason === 'no_buyer_code'
              ? 'Bonul nu înscrie codul de TVA al companiei: nu ține loc de factură simplificată, iar TVA nu se deduce (norme pct. 69 alin. (6) din Codul fiscal). Înregistrați-l cu deduction: none, TVA rămânând în cheltuială.'
              : `Bonul de ${body.totals.gross} lei depășește ${outcome.limit!.eur} euro (${outcome.limit!.lei} lei la cursul BNR de ${outcome.limit!.rate.rate} din ${outcome.limit!.rate.date}): nu ține loc de factură simplificată (art. 319 alin. (12) lit. a)), iar TVA nu se deduce fără factură. Înregistrați-l cu deduction: none, sau înregistrați factura furnizorului dacă există.`,
          input.allocations ? 'allocations' : 'deduction',
          { reason: outcome.reason, clauses: RECEIPT_CLAUSES },
        ),
      );
    if (outcome && !outcome.simplified && outcome.reason !== 'non_payer')
      issues.push(
        outcome.reason === 'over_limit'
          ? warn(
              'RECEIPT_INVOICE_EXPECTED',
              `Bonul cu codul companiei depășește ${outcome.limit!.eur} euro: furnizorul emite factura (e-Factura) pentru această achiziție. Dacă factura sosește, ea este documentul care justifică TVA: stornați atunci această înregistrare și înregistrați factura, ca achiziția să nu fie înregistrată de două ori.`,
              { limit: outcome.limit!.lei, clauses: RECEIPT_CLAUSES },
            )
          : {
              code: 'RECEIPT_NOT_SIMPLIFIED_INVOICE',
              severity: 'info',
              message: `Bonul nu înscrie codul de TVA al companiei: cheltuiala se înregistrează cu TVA inclusă (${body.totals.tax} lei).`,
              details: { reason: outcome.reason, clauses: RECEIPT_CLAUSES },
            },
      );
    if (outcome?.simplified && !outcome.vatCode && deducts)
      issues.push(
        warn(
          'RECEIPT_BUYER_CODE',
          `Bonul înscrie codul fiscal al companiei fără prefixul RO (${body.buyerTaxId}); normele (pct. 69 alin. (6)) cer codul de înregistrare în scopuri de TVA. Confirmați că bonul justifică deducerea (lectura motorului: codul companiei plătitoare de TVA o identifică; lectura e la expert, ro.vat.simplified_invoice.limit_eur).`,
          { buyerTaxId: body.buyerTaxId, clauses: RECEIPT_CLAUSES },
        ),
      );
    if (simplified)
      issues.push(
        ...rateIssues(
          taxes.map((tax) => tax.rate),
          rules,
          taxPoint,
        ),
      );

    // The seller inactive on the receipt's date: no deduction (art. 11 alin. (7)).
    const seller = record.partyId
      ? loaded.partyStatus.get(partyStatusKey(record.partyId, taxPoint))
      : undefined;
    if (simplified && deducts && seller?.inactive)
      issues.push(
        block(
          'SUPPLIER_INACTIVE',
          `Vânzătorul ${seller.name} (CUI ${seller.cui}) era inactiv la ${taxPoint}: cheltuiala și TVA aferente nu se deduc (art. 11 alin. (7) din Codul fiscal). Înregistrați bonul cu deduction: none.`,
          input.allocations ? 'allocations' : 'deduction',
          { clause: INACTIVE_CLAUSE, date: seller.date, evidenceId: seller.evidenceId },
        ),
      );
    const vehicles =
      simplified && !seller?.inactive
        ? vehicleIssues(parts, body, record.id, loaded, taxPoint)
        : { issues: [], decided: [] };
    issues.push(...vehicles.issues);

    // The payment.
    const total = ron(body.totals.gross);
    const payment = input.payment;
    if (input.reportEvidenceId && !loaded.evidence.has(input.reportEvidenceId))
      issues.push(block('EVIDENCE', 'Decontul nu este disponibil.', 'reportEvidenceId'));
    if ((payment.method === 'advance' || payment.method === 'employee') && !input.reportEvidenceId)
      issues.push(
        block(
          'EXPENSE_REPORT',
          'Bonul plătit de un salariat se justifică prin decontul de cheltuieli: indicați-l (reportEvidenceId).',
          'reportEvidenceId',
        ),
      );
    let cashAfter: bigint | null = null;
    if (payment.method === 'cash') {
      const balance = (
        loaded.turnover.get(turnoverKey(cashQuery(payment.account, taxPoint))) ?? []
      ).reduce((sum, row) => sum + row.debit - row.credit, 0n);
      cashAfter = balance - total;
      if (cashAfter < 0n)
        issues.push(
          block(
            'CASH_NEGATIVE',
            `Casieria ar avea un sold negativ (${lei(cashAfter)} lei) la ${taxPoint}.`,
            'payment',
          ),
        );
      try {
        const limits = rules.param<CashLimits>('ro.cash.limits', 'payment_date', taxPoint);
        const party = loaded.parties.get(record.partyId ?? '');
        if (
          (party?.kind === 'ro_legal_entity' || party?.kind === 'ro_individual_enterprise') &&
          total > ron(limits.operator)
        )
          issues.push(
            warn(
              'CASH_LIMIT',
              `Plata în numerar de ${lei(total)} lei depășește plafonul zilnic de ${limits.operator} lei pentru o persoană juridică sau PFA (Legea nr. 70/2015): confirmați excepția.`,
            ),
          );
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        issues.push(block('RULE_GAP', error.message));
      }
    }
    const advance =
      payment.method === 'advance' ? loaded.openItems.get(payment.advanceId) : undefined;
    if (payment.method === 'advance') {
      if (!advance || advance.controlAccount !== '542')
        issues.push(
          block('ADVANCE', 'Poziția nu este un avans spre decontare (542).', 'payment.advanceId'),
        );
      else if (total > advance.balanceBani)
        issues.push(
          block(
            'EXCESS',
            `Bonul (${lei(total)} lei) depășește avansul nedecontat (${lei(advance.balanceBani)} lei): diferența, plătită de salariat din banii lui, se înregistrează cu payment: employee pe un alt bon, sau i se plătește întâi ca avans.`,
            'payment',
          ),
        );
    }
    const employee =
      payment.method === 'employee' ? loaded.parties.get(payment.partyId) : undefined;
    if (payment.method === 'employee' && employee?.kind !== 'ro_individual')
      issues.push(
        block(
          'EMPLOYEE',
          'Indicați salariatul care a plătit, ca persoană fizică (parties.create, ro_individual).',
          'payment.partyId',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    // Each part's VAT is its share of its rate's VAT, by the amounts with VAT; what it deducts
    // goes to 4426, the rest stays in the expense.
    const partTax = parts.map(() => 0n);
    if (simplified)
      for (const tax of taxes) {
        const members = parts.flatMap((part, index) => (part.rate === tax.rate ? [index] : []));
        allocate(
          tax.tax,
          members.map((index) => parts[index]!.gross),
        ).forEach((value, i) => (partTax[members[i]!] = value));
      }
    const limited = parts.some((part) => part.deduction === 'limited')
      ? parseScaled(
          rules.param<string>('ro.vat.deduction.limited', 'vat_chargeability_date', taxPoint),
          4,
        )
      : 0n;
    const deducted = parts.map((part, index) =>
      !simplified || part.deduction === 'none'
        ? 0n
        : part.deduction === 'full'
          ? partTax[index]!
          : divRound(partTax[index]! * limited, 1_000_000n, 'halfAwayFromZero'),
    );
    const partyId = record.partyId!;
    const lines: LineSpec[] = parts.map((part, index) => ({
      account: part.account,
      side: 'D',
      bani: part.gross - deducted[index]!,
      ...(part.deduction !== 'none' && simplified && deducted[index] !== partTax[index]
        ? { memo: 'TVA nededusă inclusă' }
        : {}),
    }));
    const taxEntries: TaxEntrySpec[] = [];
    if (simplified)
      for (const tax of taxes) {
        if (tax.rate === '0' || tax.tax === 0n) continue;
        const members = parts.flatMap((part, index) => (part.rate === tax.rate ? [index] : []));
        const ledger = members.reduce((sum, index) => sum + deducted[index]!, 0n);
        if (ledger !== 0n) lines.push({ account: '4426', side: 'D', bani: ledger });
        const code = `S-${tax.rate}`;
        taxEntries.push({
          key: taxes.length === 1 ? 'vat' : `vat:${code}`,
          tax: 'VAT',
          code,
          direction: 'input',
          baseBani: tax.gross - tax.tax,
          taxBani: tax.tax,
          deductibleBani: ledger,
          ledgerBani: ledger,
          ...(ledger !== 0n ? { line: lines.length - 1 } : {}),
          taxPoint,
          exigibility: taxPoint,
          taxPeriod,
          documentId: record.id,
          partyId,
          attributes: {
            documentType: 'receipt',
            simplified: 'receipt',
            number: body.number,
            ...(body.register ? { register: body.register } : {}),
            counterpartyTaxId: body.seller.taxId,
            counterpartyCountry: body.seller.country,
          },
        });
      }
    const openItems: OpenItemSpec[] = [];
    if (payment.method === 'cash')
      lines.push({ account: payment.account, side: 'C', bani: total, memo: `BF ${body.number}` });
    else if (payment.method === 'card') {
      openItems.push({
        ref: 'counterparty',
        kind: 'payable',
        controlAccount: '401',
        partyId,
        currency: LEDGER_CURRENCY,
        normalSide: 'C',
        mayReverse: false,
        documentId: record.id,
      });
      lines.push({ account: '401', side: 'C', bani: total, openItem: 'counterparty', partyId });
    } else if (payment.method === 'advance')
      lines.push({
        account: '542',
        side: 'C',
        bani: total,
        openItem: advance!.id,
        partyId: advance!.partyId,
        memo: `BF ${body.number}`,
      });
    else {
      // What the employee paid is owed to them: 542 in credit until they are repaid.
      openItems.push({
        ref: 'employee',
        kind: 'receivable',
        controlAccount: '542',
        partyId: payment.partyId,
        currency: LEDGER_CURRENCY,
        normalSide: 'D',
        mayReverse: true,
        documentId: record.id,
      });
      lines.push({
        account: '542',
        side: 'C',
        bani: total,
        openItem: 'employee',
        partyId: payment.partyId,
        memo: `BF ${body.number}`,
      });
    }
    const deductedTotal = deducted.reduce((sum, value) => sum + value, 0n);
    const reason = outcome && !outcome.simplified ? outcome.reason : null;
    const effect: Effect = {
      schema: 'effect@1',
      date: taxPoint,
      journalClass: 'general',
      journalCode: 'CUMPARARI',
      description: `Bon fiscal ${body.number} ${body.seller.name}`.slice(0, 500),
      lines,
      openItems,
      taxEntries,
      schedules: [],
      explanation: {
        summary: simplified
          ? `Bon fiscal ${body.number} din ${body.issueDate}, factură simplificată: total ${body.totals.gross} lei, TVA ${body.totals.tax} lei, dedusă ${lei(deductedTotal)} lei; ${paymentText(payment)}.`
          : `Bon fiscal ${body.number} din ${body.issueDate}: ${body.totals.gross} lei în cheltuieli, cu TVA de ${body.totals.tax} lei nededusă; ${paymentText(payment)}.`,
        details: {
          taxPoint,
          simplifiedInvoice: simplified,
          ...(reason ? { reason } : {}),
          ...(outcome?.limit
            ? {
                limit: {
                  eur: outcome.limit.eur,
                  lei: outcome.limit.lei,
                  rate: outcome.limit.rate.rate,
                  rateDate: outcome.limit.rate.date,
                },
              }
            : {}),
          ...(body.buyerTaxId ? { buyerTaxId: body.buyerTaxId } : {}),
          payment: payment.method,
          ...(cashAfter !== null ? { cashBalance: lei(cashAfter) } : {}),
          ...(vehicles.decided.length
            ? { vehicles: vehicles.decided, vehicleClauses: VEHICLE_CLAUSES }
            : {}),
          // The VAT not deducted is part of the expense, for the profit tax as well.
          ...(deductedTotal !== ron(body.totals.tax)
            ? {
                profitTax: {
                  vatInExpense: lei(ron(body.totals.tax) - deductedTotal),
                  clause: PROFIT_CLAUSE,
                },
              }
            : {}),
          clauses: RECEIPT_CLAUSES,
        },
      },
    };
    return { effect, issues };
  },
};

function paymentText(payment: ReceiptPayment) {
  switch (payment.method) {
    case 'cash':
      return `plătit din casierie (${payment.account})`;
    case 'card':
      return 'plătit cu cardul (datorie față de vânzător, stinsă de extrasul de cont)';
    case 'advance':
      return 'plătit de salariat din avansul spre decontare (542)';
    case 'employee':
      return 'plătit de salariat din banii lui (datorat lui pe 542)';
  }
}
