import { z } from 'zod';
import {
  accountCodePattern,
  vatPeriodOf,
  type Evaluation,
  type Issue,
  type JsonValue,
  type ReadPlan,
  type Treatment,
} from '../../kernel';
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, isLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';
import { euVatPrefixes } from '../geo';
import { invoiceStockInput } from '../stock/invoices';
import { invoiceKinds, invoiceRecognition, recognitionInput } from '../treatments/invoices';
import { tradeArrangements, type TradeArrangement } from './codes';
import type { SupplyRule, TransportRule, ViesRule } from './parameters';
import {
  proofEvidence,
  transportPresumption,
  transportProofInput,
  viesOf,
  viesVerdict,
} from './proof';

/*
 * An intra-community supply of goods (Codul fiscal art. 294 alin. (2) lit. a)): an issued invoice
 * in category K to a business with a VAT code of another Member State, exempt with the right of
 * deduction, booked by `invoices.recognize` (its revenue, its goods out of the stock register,
 * the EX-IC entry of D300 rd. 1 and D390 type L) with what the exemption rests on: the buyer's
 * code valid in VIES (a `vies.check` document), the transport to the other Member State
 * (Regulation (EU) No 282/2011 art. 45a; OMFP nr. 103/2016 art. 10), and the tax point of art.
 * 283 alin. (1): the invoice, or the 15th of the month after the supply when none was issued by
 * then.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const day = z.string().refine((value): boolean => isLocalDate(value), 'Dată invalidă.');
const block = (code: string, message: string, path?: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const ack = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});
const info = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'info',
  message,
  ...(details === undefined ? {} : { details }),
});

export const euSupplyInput = z
  .object({
    documentId: z.uuid(),
    /** The revenue account (707 for goods, 70x). */
    account: z.string().regex(accountCodePattern).optional(),
    /** The invoice's K amount split over revenue accounts, in the document's currency. */
    allocations: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    /** How the supply is arranged: only `standard` is covered. */
    arrangement: z.enum(tradeArrangements),
    /** The date the goods were dispatched (the chargeable event), when the invoice does not
     * state it (BT-72): from the transport document. */
    supplyDate: day.optional(),
    /** The VIES answer about the buyer's code (`parties.checkVies`, or the VIES page recorded). */
    viesDocumentId: z.uuid(),
    /** The transport's evidence (art. 45a); later with `goods.proof` when it is not here yet. */
    transport: transportProofInput.optional(),
    /** The goods out of the stock register (G1). */
    stock: invoiceStockInput.optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
  });
export type EuSupplyInput = z.infer<typeof euSupplyInput>;

/** The day of the month after `supplied`'s: art. 283 alin. (1) and 284 alin. (2). */
export function fifteenthAfter(supplied: LocalDate, day: number): LocalDate {
  const [year, month] = supplied.split('-').map(Number) as [number, number];
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return `${next}-${String(day).padStart(2, '0')}` as LocalDate;
}

/** The invoice's or the stated supply date, or why there is none. */
export function supplyDateOf(
  body: InvoiceDocument,
  stated: string | undefined,
): { date: LocalDate } | Issue {
  if (body.deliveryDate && stated && body.deliveryDate !== stated)
    return block(
      'SUPPLY_DATE',
      `Factura înscrie data livrării ${body.deliveryDate}, iar documentul de transport ${stated}: corectați una dintre ele.`,
      'supplyDate',
    );
  const date = body.deliveryDate ?? stated;
  if (!date)
    return block(
      'SUPPLY_DATE',
      'Factura nu înscrie data livrării (BT-72): indicați data expedierii bunurilor (supplyDate), din documentul de transport. Ea este faptul generator; exigibilitatea este data facturii sau a 15-a zi a lunii următoare.',
      'supplyDate',
    );
  return { date: date as LocalDate };
}

export const unsupportedArrangement = (arrangement: TradeArrangement): Issue | null =>
  arrangement === 'standard'
    ? null
    : arrangement === 'call_off_stock'
      ? block(
          'CALL_OFF_STOCK',
          'Regimul stocurilor la dispoziția clientului (art. 270^1: transferul, registrul, declararea în D390 a codului clientului și livrarea ulterioară) nu este acoperit: tratați operațiunea în afara aplicației, atribuit explicit.',
          'arrangement',
        )
      : block(
          'TRIANGULATION',
          'Operațiunile triunghiulare (art. 276 alin. (5), art. 307 alin. (4): livrarea cu cod T în D390, achiziția neimpozabilă a cumpărătorului revânzător, taxa datorată de beneficiarul final) nu sunt acoperite: tratați operațiunea în afara aplicației, atribuit explicit.',
          'arrangement',
        );

function rule<T>(rules: RuleContext, key: string, at: LocalDate): T | Issue {
  try {
    return rules.param<T>(key, 'vat_chargeability_date', at);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return block('RULE_GAP', error.message);
  }
}
const isIssue = (value: unknown): value is Issue =>
  typeof value === 'object' && value !== null && 'severity' in value && 'code' in value;

/** The input `invoices.recognize` books the invoice with. */
const recognitionOf = (input: EuSupplyInput) =>
  recognitionInput.parse({
    documentId: input.documentId,
    ...(input.account ? { account: input.account } : {}),
    ...(input.allocations
      ? { allocations: input.allocations.map((part) => ({ ...part, vat: 'K' })) }
      : {}),
    exemption: 'art.294(2)(a)',
    ...(input.stock ? { stock: input.stock } : {}),
  });

export const euSupplyRecognition: Treatment<EuSupplyInput> = {
  id: 'goods.euSupply',
  version: 1,
  description:
    'Livrare intracomunitară de bunuri scutită (art. 294 alin. (2) lit. a)): venitul, ieșirea din gestiune, codul cumpărătorului verificat în VIES, dovada transportului și exigibilitatea art. 283 (D300 rd. 1, D390 L).',
  input: euSupplyInput,
  agent: true,
  summary:
    "An intra-community supply of goods: exempt revenue, goods out of stock, the buyer's VIES check, the transport proof (Reg. 282/2011 art. 45a) and the art. 283 tax point; D300 rd. 1, D390 L.",
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan(input): ReadPlan {
    const base = invoiceRecognition.plan(recognitionOf(input));
    return {
      ...base,
      documents: [...(base.documents ?? []), input.viesDocumentId],
      evidence: [...(base.evidence ?? []), ...proofEvidence(input.transport)],
      profile: true,
    };
  },
  followUp: (input, loaded) => invoiceRecognition.followUp?.(recognitionOf(input), loaded) ?? null,
  evaluate(input, loaded, rules): Evaluation {
    const record = loaded.documents.get(input.documentId);
    if (!record || record.kind !== invoiceKinds.sale)
      return {
        effect: null,
        issues: [
          block(
            'DOCUMENT_KIND',
            'Se recunoaște aici o factură emisă (nu o notă de credit) pentru o livrare intracomunitară.',
            'documentId',
          ),
        ],
      };
    const body = invoiceDocumentSchema.parse(record.body);
    const issues: Issue[] = [];
    const arrangement = unsupportedArrangement(input.arrangement);
    if (arrangement) issues.push(arrangement);
    const customer = body.customer;
    const prefix = euVatPrefixes[customer.country];
    if (!prefix || customer.country === 'RO')
      issues.push(
        block(
          'NOT_EU_CUSTOMER',
          `Clientul din ${customer.country} nu este dintr-un alt stat membru: un export se înregistrează cu goods.export, o livrare internă cu invoices.recognize.`,
        ),
      );
    const supplied = supplyDateOf(body, input.supplyDate);
    if ('code' in supplied) issues.push(supplied);
    const recognized = invoiceRecognition.evaluate(recognitionOf(input), loaded, rules);
    // The generic acknowledgement of the exemption's documents is replaced by what they show.
    issues.push(...recognized.issues.filter((issue) => issue.code !== 'EXEMPTION_PROOF'));
    if ('code' in supplied || !prefix) return { effect: null, issues };
    const supplyRule = rule<SupplyRule>(rules, 'ro.vat.intra_eu.supply', supplied.date);
    const viesRule = rule<ViesRule>(rules, 'ro.vat.intra_eu.vies', supplied.date);
    const transportRule = rule<TransportRule>(rules, 'ro.vat.intra_eu.transport', supplied.date);
    for (const value of [supplyRule, viesRule, transportRule])
      if (isIssue(value)) issues.push(value);
    if (isIssue(supplyRule) || isIssue(viesRule) || isIssue(transportRule))
      return { effect: null, issues };

    // Art. 283 alin. (1): the invoice, or the 15th of the next month when issued after it.
    const due = fifteenthAfter(supplied.date, supplyRule.exigibilityDay);
    const exigibility = (body.issueDate <= due ? body.issueDate : due) as LocalDate;
    if (body.issueDate > due)
      issues.push(
        ack(
          'INVOICE_LATE',
          `Factura este emisă la ${body.issueDate}, după ${due}: exigibilitatea livrării intracomunitare intervine la ${due} (art. 283 alin. (1)), în perioada în care se declară (D300 rd. 1, D390); factura trebuia emisă până atunci (art. 319 alin. (16)).`,
          { clauses: [`${CODE}:art.283(1)`] },
        ),
      );

    // The buyer's code in VIES (art. 294 alin. (2) lit. a); OMFP nr. 103/2016 art. 10 alin. (1)).
    const code = customer.taxId.toUpperCase().replace(/\s+/g, '');
    const vies = viesOf(loaded, input.viesDocumentId);
    if ('code' in vies) issues.push(vies);
    else issues.push(...viesVerdict(vies.check, code, supplied.date, exigibility, viesRule));

    // The transport (art. 45a; OMFP nr. 103/2016 art. 10 alin. (7)), now or within the days of
    // art. 1 alin. (4).
    const proofDue = addDays(supplied.date, supplyRule.proofDays);
    let proof: JsonValue = { status: 'pending', due: proofDue };
    if (!input.transport || !input.transport.documents.length) {
      issues.push(
        ack(
          'TRANSPORT_PENDING',
          `Documentele transportului în ${customer.country} nu sunt încă înregistrate: se prezintă până la ${proofDue} (${supplyRule.proofDays} de zile de la livrare, OMFP nr. 103/2016 art. 1 alin. (4)), cu goods.proof; altfel livrarea se taxează de la faptul generator.`,
          { due: proofDue, clauses: ['OMFP103/2016:art.1(4)', 'REG282/2011-A:art.45a'] },
        ),
      );
    } else {
      const verdict = transportPresumption(
        input.transport,
        customer.country,
        supplied.date,
        transportRule,
      );
      const missing = input.transport.documents.some(
        (item) => !loaded.evidence.has(item.evidenceId),
      );
      if (missing)
        issues.push(
          block('EVIDENCE', 'Un document de transport nu este în registre.', 'transport'),
        );
      if (verdict.presumed) {
        proof = { status: 'presumed', documents: verdict.counted };
        issues.push(
          info(
            'TRANSPORT_PRESUMED',
            `Transportul în ${customer.country} este prezumat (Regulamentul (UE) nr. 282/2011 art. 45a): ${verdict.counted.length} dovezi necontradictorii de la emitenți independenți.`,
          ),
        );
      } else if (transportRule.presumption === 'required')
        issues.push(
          block(
            'TRANSPORT_PROOF',
            `Prezumția transportului (art. 45a) nu este îndeplinită: ${verdict.reasons.join(' ')}`,
            'transport',
          ),
        );
      else {
        proof = {
          status: 'documents',
          documents: input.transport.documents.map((d) => d.evidenceId),
        };
        issues.push(
          ack(
            'TRANSPORT_PROOF',
            `Prezumția transportului (Regulamentul (UE) nr. 282/2011 art. 45a) nu este îndeplinită: ${verdict.reasons.join(' ')} Scutirea se sprijină pe documentele OMFP nr. 103/2016 art. 10, care trebuie să ateste în mod neechivoc transportul din România în ${customer.country}: confirmați.`,
            {
              reasons: verdict.reasons,
              clauses: ['REG282/2011-A:art.45a', 'OMFP103/2016:art.10(1),(7)'],
            },
          ),
        );
      }
    }
    issues.push(
      info(
        'D390_REQUIRED',
        `Livrarea se declară în D390 (tip L) pentru ${exigibility.slice(0, 7)}: scutirea nu se aplică dacă declarația lipsește sau este incorectă (art. 294 alin. (2^1)).`,
        { clauses: [`${CODE}:art.294(2^1)`, `${CODE}:art.325(1)`] },
      ),
    );
    if (!recognized.effect || issues.some((issue) => issue.severity === 'block'))
      return { effect: null, issues };

    const taxPeriod = vatPeriodOf(loaded, exigibility);
    const effect = {
      ...recognized.effect,
      taxEntries: recognized.effect.taxEntries.map((entry) => ({
        ...entry,
        taxPoint: exigibility,
        exigibility,
        taxPeriod,
        attributes: {
          ...entry.attributes,
          supplied: supplied.date,
          counterpartyTaxId: code,
          counterpartyCountry: customer.country,
          arrangement: input.arrangement,
          ...(!('code' in vies) ? { vies: vies.check.requestDate } : {}),
          proof: (proof as { status: string }).status,
          proofDue,
        },
      })),
      explanation: {
        summary: `Livrare intracomunitară ${body.number} către ${customer.name} (${code}): scutită (art. 294 alin. (2) lit. a)), exigibilă la ${exigibility} (art. 283), D300 rd. 1 și D390 L pentru ${exigibility.slice(0, 7)}.`,
        details: {
          ...((recognized.effect.explanation.details as Record<string, JsonValue>) ?? {}),
          supplied: supplied.date,
          exigibility,
          vies: 'code' in vies ? null : { ...vies.check },
          transport: proof,
          clauses: [
            `${CODE}:art.294(2)`,
            `${CODE}:art.283(1)`,
            'OMFP103/2016:art.10(1),(7)',
            'REG282/2011-A:art.45a',
          ],
        },
      },
    };
    return { effect, issues };
  },
};

/** What an exempt supply's proof stands on: none yet, the presumption of art. 45a, other
 * documents the reviewer confirmed, or the customs certification of the exit. */
export type ProofStatus = 'pending' | 'presumed' | 'documents' | 'certified';
