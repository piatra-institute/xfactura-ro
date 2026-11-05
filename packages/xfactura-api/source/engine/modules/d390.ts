import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { profileAt, vatPeriodOf, type ReadSetEntry } from 'xfactura-core/kernel';
import {
  checkD390,
  d390Countries,
  writeD390,
  type D390,
  type D390Operation,
} from 'xfactura-core/ro/declarations/d390';
import { counties, euVatPrefixes } from 'xfactura-core/ro/geo';
import { crossBorderCodes } from 'xfactura-core/ro/treatments/cross-border';
import { exemptCodes } from 'xfactura-core/ro/exempt';
import { tradeCodes } from 'xfactura-core/ro/trade';
import type { RuleContext } from 'xfactura-core/rules';
import { monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { companies } from '../db/schema';
import { loadState } from '../kernel/state';
import { rounding, sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';

export const d390Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** The books' intra-Community operations and their D390 types: P services supplied, S
 * acquired, L goods supplied exempt (art. 294 alin. (2) lit. a), art. 325 alin. (1) lit. a)), A
 * goods acquired, taxable (lit. d); core ro/trade). Triangular supplies (T) and the farmers' (R)
 * are not booked. */
const typeByCode: Record<string, D390Operation['type']> = {
  [crossBorderCodes.sale.eu]: 'P',
  [crossBorderCodes.purchase.eu]: 'S',
  [exemptCodes.intraCommunity]: 'L',
  ...Object.fromEntries(['21', '11', '19'].map((rate) => [tradeCodes.acquisition(rate), 'A'])),
};

/** The month's entries: D390 is monthly even when the VAT period is a quarter. */
async function inputsOf(tx: Transaction, companyId: string, month: string) {
  const end = monthEnd(month as Month);
  const profile = await loadState(tx, companyId, { profile: true });
  const period = vatPeriodOf(profile.loaded, end);
  const { loaded, readSet } = await loadState(tx, companyId, {
    taxPeriods: [{ tax: 'VAT', period }],
    profile: true,
  });
  const entries = (loaded.taxLedger.get(`VAT|${period}`)?.entries ?? []).filter(
    (entry) =>
      entry.direction === 'output' && entry.code in typeByCode && entry.taxPoint.startsWith(month),
  );
  const parties = await loadState(tx, companyId, {
    parties: [...new Set(entries.flatMap((entry) => (entry.partyId ? [entry.partyId] : [])))],
  });
  const seller = await sellerDetails(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    ...parties.readSet,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  // Outside VAT the statement is the art. 317 code holder's (art. 325 alin. (1)).
  const registered =
    profileAt(loaded, 'vat.status', end) === 'normal_vat' ||
    profileAt(loaded, 'vat.eu', end) === 'special';
  return { entries, parties: parties.loaded.parties, seller, inputs, registered };
}

/** The recapitulative statement (D390 VIES) of a month's intra-Community operations. */
export function d390Declaration(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  return {
    kind: 'D390',
    description: 'Declarație recapitulativă privind operațiunile intracomunitare (D390 VIES)',
    tax: null,
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    format: (month) => (month >= '2020-03' ? 'D390 v3' : null),
    options: d390Options,
    inputs: async (tx, companyId, month) => (await inputsOf(tx, companyId, month)).inputs,
    async prepare(tx, companyId, month, raw) {
      const options = d390Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { entries, parties, seller, inputs, registered } = await inputsOf(tx, companyId, month);
      if (!registered)
        problems.push({
          code: 'D390_NO_CODE',
          message:
            'Firma nu este înregistrată în scopuri de TVA (art. 316) și nu are cod de TVA după art. 317: declarația recapitulativă o depun doar persoanele înregistrate (art. 325 alin. (1)); solicitați codul art. 317 și înregistrați-l (vat.eu special).',
        });
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      const roundToLeu = await rounding(rules, tx, companyId, `${month}-01` as LocalDate, problems);
      const groups = new Map<string, { operation: Omit<D390Operation, 'base'>; bani: bigint }>();
      for (const entry of entries) {
        const party = entry.partyId ? parties.get(entry.partyId) : undefined;
        const prefix = party ? euVatPrefixes[party.country] : undefined;
        if (!party || !prefix || !(d390Countries as readonly string[]).includes(prefix)) {
          problems.push({
            code: 'D390_PARTNER',
            message: 'Un partener intracomunitar nu are țara sau codul de TVA recunoscute.',
          });
          continue;
        }
        const code = (party.taxId ?? '').toUpperCase().replace(/\s/g, '');
        const operation = {
          type: typeByCode[entry.code]!,
          country: prefix as D390Operation['country'],
          ...(code.startsWith(prefix) ? { code: code.slice(prefix.length) } : {}),
          name: party.name,
        };
        const key = [operation.type, operation.country, operation.code ?? '', operation.name].join(
          '|',
        );
        const group = groups.get(key) ?? { operation, bani: 0n };
        group.bani += entry.baseBani;
        groups.set(key, group);
      }
      if (problems.length || !seller || !roundToLeu)
        return { xml: '', inputs, problems, summary: null };
      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D390 = {
        period: { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) },
        rectification: false,
        declarant: options.declarant,
        company: {
          cui: company!.cui,
          name: details.name,
          address: [
            ...address.lines,
            address.city,
            address.subdivision ? counties[address.subdivision] : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          ...(options.phone ? { phone: options.phone } : {}),
          ...(options.email ? { email: options.email } : {}),
        },
        operations: [...groups.values()].map(({ operation, bani }) => ({
          ...operation,
          base: Number(roundToLeu(bani)),
        })),
      };
      problems.push(...checkD390(model).map(({ code, message }) => ({ code, message })));
      return {
        xml: problems.length ? '' : writeD390(model),
        inputs,
        problems,
        summary: { month, operations: model.operations },
      };
    },
  };
}
