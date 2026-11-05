import { z } from 'zod';
import {
  accountCodePattern,
  type Evaluation,
  type Issue,
  type JsonValue,
  type Loaded,
  type ReadPlan,
  type Treatment,
} from '../../kernel';
import { RuleGapError } from '../../rules';
import { addDays, type LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { euVatPrefixes } from '../geo';
import { invoiceStockInput } from '../stock/invoices';
import {
  chargeabilityOf,
  invoiceKinds,
  invoiceRecognition,
  recognitionInput,
} from '../treatments/invoices';
import {
  customsDeclarationSchema,
  customsDocumentKind,
  type CustomsDeclaration,
} from './documents';
import type { ExportProofRule } from './parameters';

/*
 * An export of goods (Codul fiscal art. 294 alin. (1) lit. a)–b)): an issued invoice in category
 * G (or E with VATEX-EU-G) to a customer outside the Union, exempt with the right of deduction
 * (D300 rd. 14, SAF-T 310313), booked by `invoices.recognize` with its goods out of the stock
 * register, and justified by the customs declaration of export whose exit the office certified
 * (OMFP nr. 103/2016 art. 2 alin. (2)), within the days of art. 1 alin. (4).
 */

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
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

export const exportInput = z
  .object({
    documentId: z.uuid(),
    account: z.string().regex(accountCodePattern).optional(),
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
    /** The customs declaration of export (`customs.declaration`, procedure export); later with
     * `goods.proof` when its exit is not certified yet. */
    declarationId: z.uuid().optional(),
    stock: invoiceStockInput.optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
  });
export type ExportInput = z.infer<typeof exportInput>;

/** The exempt category the invoice is in: G, or E with VATEX-EU-G. */
const exportCategory = (body: { taxes: { category: string }[] }) =>
  body.taxes.find((tax) => tax.category === 'G' || tax.category === 'E')?.category ?? 'G';

/** What a declaration of export proves for an invoice, or why it does not. */
export function exportProofOf(
  declaration: CustomsDeclaration,
  invoice: { number: string; currency: string; total: string },
): { certified: string | null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (declaration.procedure !== 'export')
    issues.push(
      block('DECLARATION_PROCEDURE', 'Declarația vamală nu este de export.', 'declarationId'),
    );
  const listed = declaration.invoices.find(
    (item) => item.number.replace(/\s+/g, '') === invoice.number.replace(/\s+/g, ''),
  );
  if (!listed)
    issues.push(
      block(
        'DECLARATION_INVOICE',
        `Declarația vamală ${declaration.mrn} nu cuprinde factura ${invoice.number}.`,
        'declarationId',
      ),
    );
  else if (listed.currency !== invoice.currency || listed.amount !== invoice.total)
    issues.push(
      ack(
        'DECLARATION_AMOUNT',
        `Declarația vamală ${declaration.mrn} înscrie factura ${invoice.number} cu ${listed.amount} ${listed.currency}, iar factura are ${invoice.total} ${invoice.currency}: confirmați că este aceeași operațiune.`,
      ),
    );
  return { certified: declaration.exit?.certifiedOn ?? null, issues };
}

const recognitionOf = (input: ExportInput, loaded?: Loaded) => {
  const body = invoiceDocumentSchema.safeParse(loaded?.documents.get(input.documentId)?.body);
  const category = body.success ? exportCategory(body.data) : 'G';
  return recognitionInput.parse({
    documentId: input.documentId,
    ...(input.account ? { account: input.account } : {}),
    ...(input.allocations
      ? { allocations: input.allocations.map((part) => ({ ...part, vat: category })) }
      : {}),
    exemption: 'art.294(1)(a)-(b)',
    ...(input.stock ? { stock: input.stock } : {}),
  });
};

export const exportRecognition: Treatment<ExportInput> = {
  id: 'goods.export',
  version: 1,
  description:
    'Export de bunuri scutit cu drept de deducere (art. 294 alin. (1) lit. a)–b)): venitul, ieșirea din gestiune și declarația vamală de export cu certificarea ieșirii (D300 rd. 14).',
  input: exportInput,
  agent: true,
  summary:
    'An export of goods: exempt revenue, goods out of stock, and the customs export declaration with the exit certified (OMFP 103/2016 art. 2); D300 rd. 14.',
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan(input): ReadPlan {
    // What `invoices.recognize` reads does not depend on the exempt category.
    const base = invoiceRecognition.plan(recognitionOf(input));
    return {
      ...base,
      documents: [...(base.documents ?? []), ...(input.declarationId ? [input.declarationId] : [])],
    };
  },
  followUp: (input, loaded) =>
    invoiceRecognition.followUp?.(recognitionOf(input, loaded), loaded) ?? null,
  evaluate(input, loaded, rules): Evaluation {
    const record = loaded.documents.get(input.documentId);
    if (!record || record.kind !== invoiceKinds.sale)
      return {
        effect: null,
        issues: [
          block(
            'DOCUMENT_KIND',
            'Se recunoaște aici o factură emisă pentru un export.',
            'documentId',
          ),
        ],
      };
    const body = invoiceDocumentSchema.parse(record.body);
    const issues: Issue[] = [];
    if (body.customer.country === 'RO' || euVatPrefixes[body.customer.country])
      issues.push(
        block(
          'NOT_EXPORT',
          `Clientul este din ${body.customer.country}, în Uniunea Europeană: o livrare intracomunitară se înregistrează cu goods.euSupply, una internă cu invoices.recognize.`,
        ),
      );
    const recognized = invoiceRecognition.evaluate(recognitionOf(input, loaded), loaded, rules);
    issues.push(...recognized.issues.filter((issue) => issue.code !== 'EXEMPTION_PROOF'));
    const supplied = chargeabilityOf(body).date;
    let rule: ExportProofRule;
    try {
      rule = rules.param<ExportProofRule>(
        'ro.vat.export.proof',
        'vat_chargeability_date',
        supplied,
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
    }
    const due = addDays(supplied, rule.proofDays) as LocalDate;
    let proof: { status: 'pending' | 'certified'; mrn?: string; certifiedOn?: string } = {
      status: 'pending',
    };
    const found = input.declarationId ? loaded.documents.get(input.declarationId) : undefined;
    if (input.declarationId && (!found || found.kind !== customsDocumentKind))
      issues.push(
        block(
          'DECLARATION',
          'Indicați declarația vamală de export (un document customs.declaration).',
          'declarationId',
        ),
      );
    else if (found) {
      const declaration = customsDeclarationSchema.parse(found.body);
      const checked = exportProofOf(declaration, {
        number: body.number,
        currency: body.currency,
        total: body.totals.payable,
      });
      issues.push(...checked.issues);
      if (checked.certified) {
        proof = { status: 'certified', mrn: declaration.mrn, certifiedOn: checked.certified };
        issues.push(
          info(
            'EXPORT_EXIT_CERTIFIED',
            `Ieșirea bunurilor din Uniune este certificată la ${checked.certified} (declarația ${declaration.mrn}, ${declaration.exit!.office}): scutirea exportului este justificată (OMFP nr. 103/2016 art. 2 alin. (2)).`,
          ),
        );
        if (checked.certified > due)
          issues.push(
            ack(
              'EXPORT_PROOF_LATE',
              `Certificarea ieșirii (${checked.certified}) este după ${due} (${rule.proofDays} de zile de la livrare): scutirea se aplică, dar după termen o inspecție ar fi colectat taxa (OMFP nr. 103/2016 art. 1 alin. (7)–(9)); confirmați.`,
            ),
          );
      } else proof = { status: 'pending', mrn: declaration.mrn };
    }
    if (proof.status === 'pending')
      issues.push(
        ack(
          'EXPORT_EXIT_PENDING',
          `Certificarea ieșirii bunurilor din Uniune nu este încă înregistrată: se prezintă până la ${due} (OMFP nr. 103/2016 art. 1 alin. (4), art. 2 alin. (2)), cu goods.proof; altfel livrarea se taxează de la faptul generator.`,
          { due, clauses: ['OMFP103/2016:art.1(4)', 'OMFP103/2016:art.2(2)'] },
        ),
      );
    if (!recognized.effect || issues.some((issue) => issue.severity === 'block'))
      return { effect: null, issues };
    const effect = {
      ...recognized.effect,
      taxEntries: recognized.effect.taxEntries.map((entry) => ({
        ...entry,
        attributes: {
          ...entry.attributes,
          counterpartyCountry: body.customer.country,
          proof: proof.status,
          proofDue: due,
          ...(proof.mrn ? { mrn: proof.mrn } : {}),
        },
      })),
      explanation: {
        summary: `Export ${body.number} către ${body.customer.name} (${body.customer.country}): scutit cu drept de deducere (art. 294 alin. (1)), D300 rd. 14; ieșirea ${proof.status === 'certified' ? `certificată la ${proof.certifiedOn}` : `de dovedit până la ${due}`}.`,
        details: {
          ...((recognized.effect.explanation.details as Record<string, JsonValue>) ?? {}),
          proof: { ...proof, due },
          clauses: [
            'ANAF/Cod-fiscal-consolidat:art.294(1)',
            'OMFP103/2016:art.2(2)',
            'OMFP103/2016:art.1(4)',
          ],
        },
      },
    };
    return { effect, issues };
  },
};
