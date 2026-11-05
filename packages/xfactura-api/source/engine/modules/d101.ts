import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import { checkD101, d101Namespace, writeD101, type D101 } from 'xfactura-core/ro/declarations/d101';
import { counties } from 'xfactura-core/ro/geo';
import { rowsOf } from 'xfactura-core/ro/profit';
import type { ProfitPosition } from 'xfactura-core/ro/treatments/profit-tax';
import type { Transaction } from '../db/database';
import { companies } from '../db/schema';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { profitPostings } from './profit';

export const d101Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    /** The company's main activity (CAEN, four digits). */
    caen: z.string().regex(/^\d{4}$/),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const pad = (value: number) => String(value).padStart(2, '0');

/** The year's last computation that stands: its own, or the rectification that replaced it. */
async function positionOf(tx: Transaction, companyId: string, year: string) {
  let found: { entryId: string; position: ProfitPosition } | null = null;
  for (const posting of await profitPostings(tx, companyId)) {
    const position = posting.position;
    if (
      position?.schema === 'profit-position@1' &&
      position.period === year &&
      position.kind !== 'quarter'
    )
      found = { entryId: posting.entryId, position };
  }
  return found;
}

/**
 * The annual profit tax return (D101) for a year, from the books: the rows of the year's posted
 * computation (`tax.profit` for the year, or its rectification after a prior-year correction,
 * which makes the return rectifying), never computed again here. For a company that left the
 * micro-enterprise regime during the year, the period starts with the quarter it left in.
 */
export function d101Declaration(): DeclarationKind {
  return {
    kind: 'D101',
    description: 'Declarație privind impozitul pe profit (D101)',
    tax: null,
    period: z.string().regex(/^\d{4}$/),
    format(year) {
      try {
        return `D101 ${d101Namespace({ from: `${year}-01-01`, to: `${year}-12-31` })}`;
      } catch {
        return null;
      }
    },
    options: d101Options,
    async inputs(tx, companyId, year) {
      const found = await positionOf(tx, companyId, year);
      const { readSet } = await loadState(tx, companyId, {
        entries: found ? [found.entryId] : [],
      });
      const seller = await sellerDetails(tx, companyId);
      const inputs: ReadSetEntry[] = [
        ...readSet,
        ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
      ];
      return inputs;
    },
    async prepare(tx, companyId, year, raw) {
      const options = d101Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const inputs = await this.inputs(tx, companyId, year);
      const found = await positionOf(tx, companyId, year);
      const seller = await sellerDetails(tx, companyId);
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      if (!found)
        problems.push({
          code: 'D101_NOTHING',
          message: `Impozitul pe profit al anului ${year} nu este calculat și înregistrat (tax.profit pentru ${year}).`,
        });
      if (problems.length || !seller || !found) return { xml: '', inputs, problems, summary: null };

      const { position } = found;
      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const quarter = position.microExitQuarter as 1 | 2 | 3 | 4 | null;
      const model: D101 = {
        period: {
          from: quarter ? `${year}-${pad(quarter * 3 - 2)}-01` : `${year}-01-01`,
          to: `${year}-12-31`,
        },
        microExitQuarter: quarter,
        rectifying: position.kind === 'rectification',
        afterReserveCancellation: null,
        declarant: options.declarant,
        payer: {
          cui: company!.cui,
          caen: options.caen,
          name: details.name,
          address: [
            ...details.address.lines,
            details.address.city,
            details.address.subdivision ? counties[details.address.subdivision] : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          ...(options.phone ? { phone: options.phone } : {}),
          ...(options.email ? { email: options.email } : {}),
        },
        rows: rowsOf(position.rows),
      };
      problems.push(
        ...checkD101(model)
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD101(model),
        inputs,
        problems,
        summary: {
          year,
          period: model.period,
          rectifying: model.rectifying,
          microExitQuarter: quarter,
          taxableProfit: position.rows.P40 ?? '0',
          loss: position.rows.P40a ?? '0',
          tax: position.rows.P48 ?? '0',
          declared: position.rows.P50 ?? '0',
          payable: position.rows.P52 ?? '0',
          recoverable: position.rows.P53 ?? '0',
        },
      };
    },
  };
}
