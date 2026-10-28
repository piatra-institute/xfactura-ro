import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  Amount,
  canonical,
  dateSchema,
  idSchema,
  requireCondition,
  unbilledSaleInput,
  unbilledSaleInvoiceInput,
  unbilledSaleTreatmentSchema,
  type GeneralBody,
  type PostingLine,
  type UnbilledSaleInput,
} from './domain';
import {
  companies,
  evidence,
  invoiceDocuments,
  invoicePostings,
  journals,
  proposals,
  unbilledSaleMatches,
  unbilledSalePostings,
} from './schema';
import { financialYearForDate, regimesAt } from './foundation';
import { invoiceRule } from './accounting-catalogue';
import { generalBody, retainGeneralProposal } from './general-ledger';
import { loadUnbilledSales, unbilledSaleView } from './unbilled-sale-state';
import { interpretUnbilledSaleInvoice } from './unbilled-sale-matching';
import { unbilledSaleControls } from './unbilled-sale-controls';

export const unbilledSaleReadInput = z.object({ id: idSchema, date: dateSchema }).strict();
export const unbilledSaleReconcileInput = z
  .object({ financialYearId: idSchema, date: dateSchema })
  .strict();
export const unbilledSalePageInput = z
  .object({
    date: dateSchema,
    onlyOpen: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: idSchema.optional(),
  })
  .strict();

export async function interpretUnbilledSale(
  tx: Transaction,
  actor: Actor,
  input: UnbilledSaleInput,
) {
  const year = await financialYearForDate(tx, actor.companyId, input.date);
  requireCondition(
    year.id === input.financialYearId,
    'FINANCIAL_YEAR',
    'Serviciile nu aparțin exercițiului selectat.',
  );
  requireCondition(
    input.serviceFrom <= input.serviceTo &&
      input.serviceFrom >= year.from &&
      input.serviceTo === input.date &&
      input.taxPointDate === input.serviceTo &&
      input.serviceFrom.slice(0, 7) === input.serviceTo.slice(0, 7) &&
      input.evidenceDate <= input.date,
    'UNBILLED_SALE_PERIOD',
    'Documentați finalizarea serviciilor, venitul și exigibilitatea în aceeași perioadă.',
  );
  requireCondition(
    /^704(?:\.|$)/.test(input.account) && new Amount(input.net).gt(0),
    'UNBILLED_SALE_SCOPE',
    'Serviciile interne de facturat necesită o valoare pozitivă și contul 704 sau un analitic.',
  );
  const [source] = await tx
    .select({ hash: evidence.hash, cui: companies.cui })
    .from(evidence)
    .innerJoin(companies, eq(companies.id, evidence.companyId))
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
  requireCondition(
    source,
    'NOT_FOUND',
    'Documentul prestării serviciilor nu este disponibil.',
    404,
  );
  requireCondition(
    source.cui !== input.customer.taxId,
    'UNBILLED_SALE_CUSTOMER',
    'Clientul trebuie să fie o altă entitate.',
  );
  const [invoiceEvidence] = await tx
    .select({ id: invoiceDocuments.id })
    .from(invoiceDocuments)
    .where(
      and(
        eq(invoiceDocuments.companyId, actor.companyId),
        eq(invoiceDocuments.evidenceId, input.evidenceId),
      ),
    );
  requireCondition(
    !invoiceEvidence,
    'UNBILLED_SALE_EVIDENCE',
    'Retineți documentul prestării; factura singură nu dovedește servicii nefacturate.',
  );
  const registrations = await regimesAt(tx, actor.companyId, input.taxPointDate);
  requireCondition(
    registrations.vat,
    'NEEDS_EVIDENCE',
    'Documentați statutul TVA la finalizarea serviciilor.',
  );
  requireCondition(
    ['normal_vat', 'non_vat'].includes(registrations.vat.value),
    'UNBILLED_SALE_VAT',
    'Statutul TVA necesită un tratament distinct.',
  );
  const normalVat = registrations.vat.value === 'normal_vat',
    ids = [registrations.vat.id];
  if (normalVat) {
    requireCondition(
      registrations.vat_collection?.value === 'no',
      'UNBILLED_SALE_VAT',
      'Documentați statutul fără TVA la încasare; celelalte regimuri cer un tratament distinct.',
    );
    ids.push(registrations.vat_collection.id);
  }
  requireCondition(
    input.vatCategory === (normalVat ? 'S' : 'O'),
    'UNBILLED_SALE_VAT',
    'Categoria TVA trebuie să corespundă statutului prestatorului.',
  );
  const rule = invoiceRule(input.taxPointDate, input.vatCategory);
  const tax = new Amount(input.net)
      .mul(rule.rate)
      .div(100)
      .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
      .toFixed(2),
    gross = new Amount(input.net).plus(tax).toFixed(2);
  const { financialYearId: _year, ...details } = input;
  const treatment = unbilledSaleTreatmentSchema.parse({
    ...details,
    schemaVersion: 1,
    tax,
    gross,
    rate: rule.rate,
    ruleId: rule.id,
    ruleHash: rule.hash,
    registrationIds: ids,
    sourceHash: source.hash,
  });
  const lines: PostingLine[] = [
    { account: '418', debit: gross, credit: '0.00' },
    { account: input.account, debit: '0.00', credit: input.net },
  ];
  // Completed, non-cash-VAT services: invoice absence never defers output tax.
  if (new Amount(tax).gt(0)) lines.push({ account: '4427', debit: '0.00', credit: tax });
  return { treatment, lines };
}
export async function checkUnbilledSalePosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  if (!body.unbilledSale) return;
  requireCondition(
    !body.invoice && !body.accrual && !body.settlement && !body.correctsJournalId,
    'MULTIPLE_ORIGINS',
    'Serviciile de facturat au o singură origine economică.',
  );
  const {
    schemaVersion: _version,
    tax: _tax,
    gross: _gross,
    rate: _rate,
    ruleId: _rule,
    ruleHash: _ruleHash,
    registrationIds: _registrations,
    sourceHash: _source,
    ...input
  } = body.unbilledSale;
  const expected = await interpretUnbilledSale(tx, actor, {
    ...input,
    financialYearId: body.financialYearId,
  });
  requireCondition(
    canonical(expected.treatment) === canonical(body.unbilledSale) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.date === input.date &&
      body.evidenceId === input.evidenceId &&
      body.purpose === 'sale' &&
      body.sourceReference === `unbilled-sale:${input.reference}`,
    'STALE_UNBILLED_SALE',
    'Sursa sau tratamentul serviciilor s-au schimbat. Revizuiți propunerea.',
    409,
  );
}

export class UnbilledSales {
  constructor(private readonly runner: Commands) {}
  propose(actor: Actor, key: string, input: unknown, revision?: { id: string; version: number }) {
    const body = unbilledSaleInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'unbilledSales.revise' : 'unbilledSales.propose',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const [posted] = await tx
          .select({ id: unbilledSalePostings.unbilledSaleId })
          .from(unbilledSalePostings)
          .where(
            and(
              eq(unbilledSalePostings.companyId, actor.companyId),
              eq(unbilledSalePostings.reference, body.reference),
            ),
          );
        requireCondition(
          !posted,
          'UNBILLED_SALE_EXISTS',
          'Serviciile sunt deja contabilizate.',
          409,
        );
        const result = await interpretUnbilledSale(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: body.evidenceId,
            date: body.date,
            purpose: 'sale',
            description: `Servicii de facturat · ${body.customer.name} · ${body.reference}`,
            sourceReference: `unbilled-sale:${body.reference}`,
            lines: result.lines,
            unbilledSale: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  matchInvoice(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = unbilledSaleInvoiceInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'unbilledSales.reviseMatch' : 'unbilledSales.matchInvoice',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const result = await interpretUnbilledSaleInvoice(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: 'sale',
            description: `Factură emisă · ${result.invoice.body.number} · ${result.invoice.body.customer.name}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  get(actor: Actor, input: unknown) {
    const body = unbilledSaleReadInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [state] = await loadUnbilledSales(tx, actor.companyId, [body.id]);
        requireCondition(
          state && state.journal.date <= body.date,
          'NOT_FOUND',
          'Serviciile nu sunt disponibile la această dată.',
          404,
        );
        return unbilledSaleView(state, body.date);
      },
      'unbilledSales.get',
    );
  }
  list(actor: Actor, input: unknown) {
    const body = unbilledSalePageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const used = tx
          .select({ amount: sql`coalesce(sum(${unbilledSaleMatches.grossBani}),0)` })
          .from(unbilledSaleMatches)
          .innerJoin(
            invoicePostings,
            and(
              eq(invoicePostings.companyId, unbilledSaleMatches.companyId),
              eq(invoicePostings.invoiceId, unbilledSaleMatches.invoiceId),
            ),
          )
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, invoicePostings.companyId),
              eq(journals.id, invoicePostings.journalId),
            ),
          )
          .where(
            and(
              eq(unbilledSaleMatches.companyId, unbilledSalePostings.companyId),
              eq(unbilledSaleMatches.unbilledSaleId, unbilledSalePostings.unbilledSaleId),
              lte(journals.date, body.date),
            ),
          );
        const rows = await tx
          .select({ id: unbilledSalePostings.unbilledSaleId })
          .from(unbilledSalePostings)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, unbilledSalePostings.companyId),
              eq(journals.id, unbilledSalePostings.journalId),
            ),
          )
          .innerJoin(
            proposals,
            and(
              eq(proposals.companyId, unbilledSalePostings.companyId),
              eq(proposals.id, unbilledSalePostings.unbilledSaleId),
            ),
          )
          .where(
            and(
              eq(unbilledSalePostings.companyId, actor.companyId),
              lte(journals.date, body.date),
              body.cursor ? gt(unbilledSalePostings.unbilledSaleId, body.cursor) : undefined,
              body.onlyOpen
                ? sql`cast(replace(json_extract(${proposals.body}, '$.unbilledSale.gross'),'.','') as integer)>(${used})`
                : undefined,
            ),
          )
          .orderBy(asc(unbilledSalePostings.unbilledSaleId))
          .limit(body.limit + 1);
        const states = await loadUnbilledSales(
            tx,
            actor.companyId,
            rows.slice(0, body.limit).map((row) => row.id),
          ),
          byId = new Map(states.map((row) => [row.record.unbilledSaleId, row]));
        return {
          items: rows
            .slice(0, body.limit)
            .map((row) => unbilledSaleView(byId.get(row.id)!, body.date)),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'unbilledSales.list',
    );
  }
  reconcile(actor: Actor, input: unknown) {
    const body = unbilledSaleReconcileInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const year = await financialYearForDate(tx, actor.companyId, body.date);
        requireCondition(
          year.id === body.financialYearId,
          'FINANCIAL_YEAR',
          'Data nu aparține exercițiului selectat.',
        );
        return {
          ...body,
          ...(await unbilledSaleControls(tx, actor.companyId, year.from, body.date)),
        };
      },
      'unbilledSales.reconcile',
    );
  }
}
