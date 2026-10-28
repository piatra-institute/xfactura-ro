import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  Amount,
  accrualInput,
  accrualAdjustmentInput,
  accrualInvoiceInput,
  accrualTreatmentSchema,
  canonical,
  generalBodySchema,
  dateSchema,
  idSchema,
  requireCondition,
  type AccrualInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import {
  accrualPostings,
  accrualMatches,
  accrualAdjustments,
  companies,
  evidence,
  invoiceDocuments,
  invoicePostings,
  journals,
  proposals,
} from './schema';
import { generalBody, retainGeneralProposal } from './general-ledger';
import { financialYearForDate, regimesAt } from './foundation';
import { invoiceRule } from './accounting-catalogue';
import { accrualView, loadAccruals } from './accrual-state';
import { interpretAccrualInvoice } from './accrual-matching';
import { accrualControls } from './accrual-controls';
import { interpretAccrualAdjustment } from './accrual-adjustments';

export const accrualReadInput = z.object({ id: idSchema, date: dateSchema }).strict();
export const accrualReconcileInput = z
  .object({ financialYearId: idSchema, date: dateSchema })
  .strict();
export const accrualPageInput = z
  .object({
    date: dateSchema,
    onlyOpen: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: idSchema.optional(),
  })
  .strict();
export const accrualAdjustmentPageInput = accrualPageInput
  .omit({ onlyOpen: true })
  .extend({ accrualId: idSchema })
  .strict();

export async function interpretAccrual(tx: Transaction, actor: Actor, input: AccrualInput) {
  const year = await financialYearForDate(tx, actor.companyId, input.date);
  requireCondition(
    year.id === input.financialYearId,
    'FINANCIAL_YEAR',
    'Angajamentul nu aparține exercițiului selectat.',
  );
  requireCondition(
    input.serviceFrom <= input.serviceTo &&
      input.serviceFrom >= year.from &&
      input.serviceTo <= input.date &&
      input.evidenceDate <= input.date &&
      input.serviceFrom.slice(0, 7) === input.date.slice(0, 7) &&
      input.taxPointDate === input.serviceTo,
    'ACCRUAL_PERIOD',
    'Documentați serviciile primite în luna recunoașterii și data lor de exigibilitate.',
  );
  requireCondition(
    /^(61[1-8]|62[1-6]|628)(?:\.|$)/.test(input.account) && new Amount(input.net).gt(0),
    'ACCRUAL_SCOPE',
    'Angajamentul acoperă servicii interne cu valoare pozitivă, în conturi 611–626 sau 628.',
  );
  const [source] = await tx
    .select({ hash: evidence.hash, companyCui: companies.cui })
    .from(evidence)
    .innerJoin(companies, eq(companies.id, evidence.companyId))
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Documentul serviciilor nu este disponibil.', 404);
  requireCondition(
    input.supplier.taxId !== source.companyCui,
    'ACCRUAL_SUPPLIER',
    'Furnizorul serviciilor trebuie să fie o altă entitate.',
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
    'ACCRUAL_EVIDENCE',
    'Folosiți documente privind primirea serviciilor; factura singură nu dovedește un angajament nefacturat.',
  );
  const registrations = await regimesAt(tx, actor.companyId, input.taxPointDate);
  requireCondition(
    registrations.vat,
    'NEEDS_EVIDENCE',
    'Este necesar statutul TVA documentat la data serviciilor.',
  );
  const ids = [registrations.vat.id];
  if (registrations.vat.value === 'normal_vat') {
    requireCondition(
      registrations.vat_collection?.value === 'no',
      'ACCRUAL_VAT',
      'Documentați statutul fără TVA la încasare; alte regimuri au tratamente distincte.',
    );
    ids.push(registrations.vat_collection.id);
  }
  requireCondition(
    input.deduction === 'none' ||
      (registrations.vat.value === 'normal_vat' && input.vatCategory === 'S'),
    'ACCRUAL_VAT',
    'TVA anticipată recuperabilă necesită înregistrare normală și o categorie acceptată.',
  );
  const rule = invoiceRule(input.taxPointDate, input.vatCategory);
  const tax = new Amount(input.net)
    .mul(rule.rate)
    .div(100)
    .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
    .toFixed(2);
  const gross = new Amount(input.net).plus(tax).toFixed(2),
    deferredTax = input.deduction === 'full' ? tax : '0.00';
  const { financialYearId: _year, ...details } = input;
  const treatment = accrualTreatmentSchema.parse({
    ...details,
    schemaVersion: 1,
    tax,
    gross,
    deferredTax,
    rate: rule.rate,
    ruleId: rule.id,
    ruleHash: rule.hash,
    registrationIds: ids,
    sourceHash: source.hash,
  });
  const lines: PostingLine[] = [
    {
      account: input.account,
      debit: new Amount(gross).minus(deferredTax).toFixed(2),
      credit: '0.00',
    },
    { account: '408', debit: '0.00', credit: gross },
  ];
  if (new Amount(deferredTax).gt(0))
    lines.push({ account: '4428', debit: deferredTax, credit: '0.00' });
  return { treatment, lines };
}

export async function checkAccrualPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  if (!body.accrual) return;
  requireCondition(
    !body.invoice && !body.settlement && !body.correctsJournalId,
    'MULTIPLE_ORIGINS',
    'Un angajament are o singură origine economică.',
  );
  const {
    schemaVersion: _version,
    tax: _tax,
    gross: _gross,
    deferredTax: _deduction,
    rate: _rate,
    ruleId: _rule,
    ruleHash: _ruleHash,
    registrationIds: _registrations,
    sourceHash: _source,
    ...input
  } = body.accrual;
  const expected = await interpretAccrual(tx, actor, {
    ...input,
    financialYearId: body.financialYearId,
  });
  requireCondition(
    canonical(expected.treatment) === canonical(body.accrual) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.date === input.date &&
      body.evidenceId === input.evidenceId &&
      body.purpose === 'purchase' &&
      body.sourceReference === `accrual:${input.reference}`,
    'STALE_ACCRUAL',
    'Sursa sau tratamentul angajamentului s-au schimbat. Revizuiți propunerea.',
    409,
  );
}

export class Accruals {
  constructor(private readonly runner: Commands) {}
  proposeAdjustment(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = accrualAdjustmentInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'accruals.reviseAdjustment' : 'accruals.proposeAdjustment',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const [posted] = await tx
          .select({ id: accrualAdjustments.proposalId })
          .from(accrualAdjustments)
          .where(
            and(
              eq(accrualAdjustments.companyId, actor.companyId),
              eq(accrualAdjustments.reference, body.reference),
            ),
          );
        requireCondition(
          !posted,
          'ACCRUAL_ADJUSTMENT_EXISTS',
          'Ajustarea este deja contabilizată.',
          409,
        );
        const result = await interpretAccrualAdjustment(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: body.evidenceId,
            date: body.date,
            purpose: 'adjustment',
            description: `${body.action === 'release' ? 'Stornare angajament' : 'Ajustare estimare'} · ${result.treatment.accrualReference} · ${body.reference}`,
            sourceReference: `accrual-adjustment:${body.reference}`,
            correctsJournalId: result.previousJournalId,
            lines: result.lines,
            accrualAdjustment: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  adjustments(actor: Actor, input: unknown) {
    const body = accrualAdjustmentPageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [root] = await tx
          .select({ id: accrualPostings.accrualId })
          .from(accrualPostings)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, accrualPostings.companyId),
              eq(journals.id, accrualPostings.journalId),
            ),
          )
          .where(
            and(
              eq(accrualPostings.companyId, actor.companyId),
              eq(accrualPostings.accrualId, body.accrualId),
              lte(journals.date, body.date),
            ),
          );
        requireCondition(
          root,
          'NOT_FOUND',
          'Angajamentul nu este disponibil la această dată.',
          404,
        );
        const rows = await tx
          .select({ record: accrualAdjustments, proposal: proposals })
          .from(accrualAdjustments)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, accrualAdjustments.companyId),
              eq(journals.id, accrualAdjustments.journalId),
            ),
          )
          .innerJoin(
            proposals,
            and(
              eq(proposals.companyId, accrualAdjustments.companyId),
              eq(proposals.id, accrualAdjustments.proposalId),
            ),
          )
          .where(
            and(
              eq(accrualAdjustments.companyId, actor.companyId),
              eq(accrualAdjustments.accrualId, body.accrualId),
              lte(journals.date, body.date),
              body.cursor ? gt(accrualAdjustments.proposalId, body.cursor) : undefined,
            ),
          )
          .orderBy(asc(accrualAdjustments.proposalId))
          .limit(body.limit + 1);
        return {
          items: rows.slice(0, body.limit).map(({ record, proposal }) => ({
            id: record.proposalId,
            journalId: record.journalId,
            proposalHash: proposal.hash,
            treatment: generalBodySchema.parse(proposal.body).accrualAdjustment!,
            createdAt: record.createdAt,
          })),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].record.proposalId : null,
        };
      },
      'accruals.adjustments',
    );
  }
  reconcile(actor: Actor, input: unknown) {
    const body = accrualReconcileInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const year = await financialYearForDate(tx, actor.companyId, body.date);
        requireCondition(
          year.id === body.financialYearId,
          'FINANCIAL_YEAR',
          'Data nu aparține exercițiului selectat.',
        );
        return { ...body, ...(await accrualControls(tx, actor.companyId, year.from, body.date)) };
      },
      'accruals.reconcile',
    );
  }
  matchInvoice(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = accrualInvoiceInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'accruals.reviseMatch' : 'accruals.matchInvoice',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const result = await interpretAccrualInvoice(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: 'purchase',
            description: `Factură primită · ${result.invoice.body.number} · ${result.invoice.body.supplier.name}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  propose(actor: Actor, key: string, input: unknown, revision?: { id: string; version: number }) {
    const body = accrualInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'accruals.revise' : 'accruals.propose',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const [posted] = await tx
          .select({ id: accrualPostings.accrualId })
          .from(accrualPostings)
          .where(
            and(
              eq(accrualPostings.companyId, actor.companyId),
              eq(accrualPostings.reference, body.reference),
            ),
          );
        requireCondition(!posted, 'ACCRUAL_EXISTS', 'Angajamentul este deja contabilizat.', 409);
        const result = await interpretAccrual(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: body.evidenceId,
            date: body.date,
            purpose: 'purchase',
            description: `Servicii primite · ${body.supplier.name} · ${body.reference}`,
            sourceReference: `accrual:${body.reference}`,
            lines: result.lines,
            accrual: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  get(actor: Actor, input: unknown) {
    const body = accrualReadInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [state] = await loadAccruals(tx, actor.companyId, [body.id]);
        requireCondition(
          state && state.journal.date <= body.date,
          'NOT_FOUND',
          'Angajamentul nu este disponibil la această dată.',
          404,
        );
        return accrualView(state, body.date);
      },
      'accruals.get',
    );
  }
  list(actor: Actor, input: unknown) {
    const body = accrualPageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const used = tx
          .select({ amount: sql`coalesce(sum(${accrualMatches.grossBani}),0)` })
          .from(accrualMatches)
          .innerJoin(
            invoicePostings,
            and(
              eq(invoicePostings.companyId, accrualMatches.companyId),
              eq(invoicePostings.invoiceId, accrualMatches.invoiceId),
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
              eq(accrualMatches.companyId, accrualPostings.companyId),
              eq(accrualMatches.accrualId, accrualPostings.accrualId),
              lte(journals.date, body.date),
            ),
          );
        const changed = tx
          .select({ amount: sql`coalesce(sum(${accrualAdjustments.grossBani}),0)` })
          .from(accrualAdjustments)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, accrualAdjustments.companyId),
              eq(journals.id, accrualAdjustments.journalId),
            ),
          )
          .where(
            and(
              eq(accrualAdjustments.companyId, accrualPostings.companyId),
              eq(accrualAdjustments.accrualId, accrualPostings.accrualId),
              lte(journals.date, body.date),
            ),
          );
        const rows = await tx
          .select({ id: accrualPostings.accrualId })
          .from(accrualPostings)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, accrualPostings.companyId),
              eq(journals.id, accrualPostings.journalId),
            ),
          )
          .innerJoin(
            proposals,
            and(
              eq(proposals.companyId, accrualPostings.companyId),
              eq(proposals.id, accrualPostings.accrualId),
            ),
          )
          .where(
            and(
              eq(accrualPostings.companyId, actor.companyId),
              lte(journals.date, body.date),
              body.cursor ? gt(accrualPostings.accrualId, body.cursor) : undefined,
              body.onlyOpen
                ? sql`cast(replace(json_extract(${proposals.body}, '$.accrual.gross'),'.','') as integer)+(${changed})>(${used})`
                : undefined,
            ),
          )
          .orderBy(asc(accrualPostings.accrualId))
          .limit(body.limit + 1);
        const states = await loadAccruals(
            tx,
            actor.companyId,
            rows.slice(0, body.limit).map((row) => row.id),
          ),
          byId = new Map(states.map((state) => [state.record.accrualId, state]));
        return {
          items: rows.slice(0, body.limit).map((row) => accrualView(byId.get(row.id)!, body.date)),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'accruals.list',
    );
  }
}
