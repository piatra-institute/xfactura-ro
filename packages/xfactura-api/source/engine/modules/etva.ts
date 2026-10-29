import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { etvaDifferences } from 'xfactura-core/ro/etva';
import { vatPeriodEnd } from 'xfactura-core/ro/treatments/vat-settlement';
import type { RuleContext } from 'xfactura-core/rules';
import { invoiceDocumentSchema } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import { artifactEvents, artifacts, documents, spvMessages } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { loadState } from '../kernel/state';
import { periodStart } from './d300';

export const etvaInput = z
  .object({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
    /** The pre-filled return RO e-TVA (P300), as the D300 elements it fills, in whole lei. */
    prefilled: z.record(z.string().regex(/^R\d+(_\d+)*$/), z.number().int()),
  })
  .strict();

/**
 * The checks RO e-TVA runs on a VAT period, before ANAF does: the period's VAT return against the
 * pre-filled one, row by row, at the significance threshold of OUG nr. 70/2024 art. 5; and the
 * documents behind the differences: e-Factura invoices of the period not in its VAT ledger, and
 * invoices in the ledger that ANAF's system has not seen through e-Factura.
 */
export class Etva {
  constructor(
    private readonly commands: Commands,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  ) {}

  check(actor: Actor, input: z.infer<typeof etvaInput>) {
    return this.commands.db.read(async (tx) => {
      const declared = await this.declaredRows(tx, actor.companyId, input.period);
      requireCondition(
        declared,
        'D300_MISSING',
        `Pregătiți decontul D300 pentru ${input.period} înainte de comparație.`,
      );
      const start = periodStart(input.period);
      const threshold = (await this.rules(tx, actor.companyId)).param<{
        percent: string;
        lei: string;
      }>('ro.etva.significance', 'reporting_period_start', start);
      const quarter = /^(\d{4})-Q([1-4])$/.exec(input.period);
      const rows = etvaDifferences(declared, input.prefilled, threshold, {
        year: Number(input.period.slice(0, 4)),
        month: quarter ? Number(quarter[2]) * 3 : Number(input.period.slice(5, 7)),
      });

      // The documents: e-Factura invoices of the period against the period's VAT ledger.
      const end = vatPeriodEnd(input.period);
      const { loaded } = await loadState(tx, actor.companyId, {
        taxPeriods: [{ tax: 'VAT', period: input.period }],
      });
      const ledger = loaded.taxLedger.get(`VAT|${input.period}`)?.entries ?? [];
      const booked = new Set(
        ledger.flatMap((entry) => (entry.documentId ? [entry.documentId] : [])),
      );
      const messages = await tx
        .select({ documentId: spvMessages.documentId, kind: spvMessages.kind })
        .from(spvMessages)
        .where(
          and(
            eq(spvMessages.companyId, actor.companyId),
            isNotNull(spvMessages.documentId),
            inArray(spvMessages.kind, ['sent', 'received']),
          ),
        );
      const throughSpv = new Set(messages.map((message) => message.documentId!));
      const described = async (ids: string[]) =>
        ids.length
          ? (
              await tx
                .select({ id: documents.id, kind: documents.kind, body: documents.body })
                .from(documents)
                .where(and(eq(documents.companyId, actor.companyId), inArray(documents.id, ids)))
                .orderBy(asc(documents.id))
            ).map((row) => {
              const body = invoiceDocumentSchema.safeParse(JSON.parse(row.body));
              return {
                documentId: row.id,
                kind: row.kind,
                number: body.success ? body.data.number : null,
                issueDate: body.success ? body.data.issueDate : null,
                taxPointDate: body.success ? (body.data.taxPointDate ?? body.data.issueDate) : null,
              };
            })
          : [];
      const notBooked = (await described([...throughSpv].filter((id) => !booked.has(id)))).filter(
        (item) =>
          item.taxPointDate !== null && item.taxPointDate >= start && item.taxPointDate <= end,
      );
      const outsideEfactura = await described([...booked].filter((id) => !throughSpv.has(id)));
      return {
        period: input.period,
        threshold,
        rows,
        significant: rows.filter((row) => row.significant).length,
        documents: { notBooked, outsideEfactura },
      };
    });
  }

  /** The rows of the period's latest VAT return in the engine that is not superseded. */
  private async declaredRows(tx: Transaction, companyId: string, period: string) {
    const rows = await tx
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.companyId, companyId),
          eq(artifacts.kind, 'D300'),
          eq(artifacts.period, period),
        ),
      )
      .orderBy(desc(artifacts.createdAt));
    for (const row of rows) {
      const steps = await tx
        .select()
        .from(artifactEvents)
        .where(and(eq(artifactEvents.companyId, companyId), eq(artifactEvents.artifactId, row.id)))
        .orderBy(asc(artifactEvents.seq));
      if (steps.some((step) => step.state === 'superseded')) continue;
      const summary = JSON.parse(steps[0]!.detail ?? '{}') as { rows?: Record<string, number> };
      if (summary.rows) return summary.rows;
    }
    return undefined;
  }
}
