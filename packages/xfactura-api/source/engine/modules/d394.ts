import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { profileAt, vatPeriodOf, type ReadSetEntry } from 'xfactura-core/kernel';
import {
  checkD394,
  d394Namespace,
  d394Rates,
  d394RefundFlags,
  writeD394,
  type D394,
  type D394Invoice,
  type D394InvoiceSeries,
  type D394Operation,
  type D394Partner,
  type D394Rate,
} from 'xfactura-core/ro/declarations/d394';
import { supplierAppliesCashVat } from 'xfactura-core/ro/cash-vat';
import { counties } from 'xfactura-core/ro/geo';
import { isValidCnp, isValidCui } from 'xfactura-core/ro/identifiers';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { regimeCodes } from 'xfactura-core/ro/treatments/vat-registration';
import { vatPeriodEnd } from 'xfactura-core/ro/treatments/vat-settlement';
import type { RuleContext } from 'xfactura-core/rules';
import { invoiceDocumentSchema } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  companies,
  issuedNumbers,
  partyVersions,
  series,
} from '../db/schema';
import { loadState } from '../kernel/state';
import { periodStart, rounding, sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';

const text = (max: number) => z.string().trim().min(1).max(max);
const range = z
  .object({
    series: text(20).optional(),
    first: z.string().regex(/^\d{1,20}$/),
    last: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
  })
  .strict();

export const d394Options = z
  .object({
    caen: z.string().regex(/^\d{4}$/),
    phone: text(15),
    email: text(200).optional(),
    representative: z
      .object({ cif: text(13).optional(), name: text(200), role: text(100), address: text(1000) })
      .strict(),
    preparer: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('company'), cui: text(10), name: text(200), capacity: text(100) })
        .strict(),
      z
        .object({
          kind: z.literal('individual'),
          cnp: z.string().regex(/^\d{13}$/),
          name: text(200),
          capacity: text(100).optional(),
          position: text(100).optional(),
        })
        .strict(),
    ]),
    /** Consent to partners consulting the transactions conducted with the company. */
    consultation: z.boolean(),
    consultationChanged: z.boolean().optional(),
    /** Operations with affiliated persons in the period. */
    affiliates: z.boolean(),
    /** Invoices the company issued in the period outside the engine's series (for example with
     * the previous invoicer): their ranges, how many, and the storno invoices among them. */
    outsideSeries: z
      .object({
        allocated: z.array(range).min(1),
        issued: z.array(range).min(1),
        invoices: z.number().int().min(1),
        storno: z
          .array(
            z
              .object({ series: text(20).optional(), number: z.string().regex(/^\d{1,20}$/) })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .optional(),
    /** The nature of the period's operations, required when its VAT return requests a refund. */
    refund: z
      .object(Object.fromEntries(d394RefundFlags.map(([flag]) => [flag, z.boolean()])))
      .strict()
      .optional(),
  })
  .strict();

const rateOf = (code: string) => {
  const rate = /^S-(\d+)$/.exec(code)?.[1];
  return rate && (d394Rates as readonly string[]).includes(rate) ? (rate as D394Rate) : null;
};
/** Codes reported elsewhere (D390, D300 rows 3 and 7): services across the border. */
const crossBorder = /^(RC|EXP)-/;

function statementPeriod(period: string): D394['period'] {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return { year: Number(quarter[1]), month: Number(quarter[2]) * 3 };
  return { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) };
}

/** The latest invoicing details of each party, for individuals identified by their address. */
async function latestDetails(tx: Transaction, companyId: string, partyId: string) {
  const [row] = await tx
    .select()
    .from(partyVersions)
    .where(and(eq(partyVersions.companyId, companyId), eq(partyVersions.partyId, partyId)))
    .orderBy(desc(partyVersions.version))
    .limit(1);
  return row;
}

/** Whether the period's VAT return, prepared in the engine, requests a refund. */
async function refundRequested(tx: Transaction, companyId: string, period: string) {
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
    return Boolean(
      (JSON.parse(steps[0]!.detail ?? '{}') as { refundRequested?: boolean }).refundRequested,
    );
  }
  return null;
}

async function inputsOf(tx: Transaction, companyId: string, period: string) {
  const ledger = await loadState(tx, companyId, {
    taxPeriods: [{ tax: 'VAT', period }],
    profile: true,
  });
  // A change of regime (V1): only the days of the normal regime, and not the regularizations of a
  // late registration or of the capital goods, which are no invoices.
  const all = (ledger.loaded.taxLedger.get(`VAT|${period}`)?.entries ?? []).filter(
    (entry) =>
      !crossBorder.test(entry.code) &&
      !(Object.values(regimeCodes) as string[]).includes(entry.code) &&
      profileAt(ledger.loaded, 'vat.status', entry.taxPoint) === 'normal_vat',
  );
  // Under VAT on collection, a collection or payment releases an invoice's VAT: the period's
  // releases are the VAT collected and deducted on payment, not operations of their own.
  const entries = all.filter((entry) => !entry.attributes.release);
  const releases = all.filter((entry) => entry.attributes.release && entry.exigibility !== null);
  const start = periodStart(period);
  const end = vatPeriodEnd(period);
  const issued = await tx
    .select({ number: issuedNumbers, series })
    .from(issuedNumbers)
    .innerJoin(
      series,
      and(eq(series.companyId, issuedNumbers.companyId), eq(series.id, issuedNumbers.seriesId)),
    )
    .where(
      and(
        eq(issuedNumbers.companyId, companyId),
        gte(issuedNumbers.issueDate, start),
        lte(issuedNumbers.issueDate, end),
      ),
    )
    .orderBy(asc(series.code), asc(issuedNumbers.number));
  const documentIds = [
    ...new Set([
      ...entries.flatMap((entry) => (entry.documentId ? [entry.documentId] : [])),
      ...issued.map((row) => row.number.documentId),
    ]),
  ];
  const partyIds = [...new Set(entries.flatMap((entry) => (entry.partyId ? [entry.partyId] : [])))];
  const read = await loadState(tx, companyId, { documents: documentIds, parties: partyIds });
  const seller = await sellerDetails(tx, companyId);
  const details = new Map<string, Awaited<ReturnType<typeof latestDetails>>>();
  for (const partyId of partyIds) details.set(partyId, await latestDetails(tx, companyId, partyId));
  const inputs: ReadSetEntry[] = [
    ...ledger.readSet,
    ...read.readSet,
    ...[...details].flatMap(([id, row]) =>
      row ? [{ kind: 'party' as const, id: `details:${id}`, version: row.detailsHash }] : [],
    ),
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  return {
    loaded: ledger.loaded,
    entries,
    releases,
    documents: read.loaded.documents,
    details,
    issued,
    seller,
    inputs,
  };
}

/**
 * The informative statement of domestic supplies and acquisitions (D394) from the VAT ledger of
 * a tax period: each partner's invoices by type and rate, the invoice series the engine issued
 * and the storno invoices among them, and the company's identification. Under VAT on collection
 * the invoices are listed with their full amounts in the period they were issued or received,
 * and the VAT collected or deducted on payment goes to tvaCol, tvaDed and tvaDedAI.
 */
export function d394Declaration(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  return {
    kind: 'D394',
    description:
      'Declarație informativă privind livrările și achizițiile pe teritoriul național (D394)',
    tax: null,
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
    format(period) {
      try {
        return `D394 ${d394Namespace(statementPeriod(period))}`;
      } catch {
        return null;
      }
    },
    options: d394Options,
    inputs: async (tx, companyId, period) => (await inputsOf(tx, companyId, period)).inputs,
    async prepare(tx, companyId, period, raw) {
      const options = d394Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { loaded, entries, releases, documents, details, issued, seller, inputs } =
        await inputsOf(tx, companyId, period);
      const end = vatPeriodEnd(period);
      if (vatPeriodOf(loaded, end) !== period)
        problems.push({
          code: 'VAT_PERIOD',
          message: `Perioada fiscală a companiei pentru ${end} este ${vatPeriodOf(loaded, end)}, nu ${period}.`,
        });
      // Registered on some day of the period: the first period after a registration, the last
      // before a cancellation (art. 316 alin. (13)).
      const first = periodStart(period);
      if (
        profileAt(loaded, 'vat.status', first) !== 'normal_vat' &&
        !loaded.profile.some(
          (fact) =>
            fact.axis === 'vat.status' &&
            fact.value === 'normal_vat' &&
            fact.effectiveFrom >= first &&
            fact.effectiveFrom <= end,
        )
      )
        problems.push({
          code: 'NOT_VAT_PAYER',
          message: 'Declarația D394 o depun persoanele înregistrate în scopuri de TVA.',
        });
      const cashSystem = profileAt(loaded, 'vat.cash', end) === 'yes';
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      const refund = await refundRequested(tx, companyId, period);
      if (refund === true && !options.refund)
        problems.push({
          code: 'D394_REFUND',
          message: 'Decontul perioadei solicită rambursarea: completați natura operațiunilor.',
        });
      if (refund !== true && options.refund)
        problems.push({
          code: 'D394_REFUND',
          message:
            'Natura operațiunilor se declară doar când decontul perioadei solicită rambursarea.',
        });
      const roundToLeu = await rounding(rules, tx, companyId, periodStart(period), problems);

      // Operations, grouped by type, rate and partner; credit notes reduce their group.
      const groups = new Map<
        string,
        {
          type: D394Operation['type'];
          rate: D394Rate;
          partner: D394Partner;
          documents: Set<string>;
          base: bigint;
          vat: bigint;
        }
      >();
      for (const entry of entries) {
        const rate = rateOf(entry.code);
        const document = entry.documentId ? documents.get(entry.documentId) : undefined;
        const body = invoiceDocumentSchema.safeParse(document?.body);
        if (!rate || !body.success || !entry.partyId) {
          problems.push({
            code: 'D394_OPERATION',
            message: `Operațiunea cu codul ${entry.code} nu are încă un loc în declarație sau nu are factură și partener.`,
          });
          continue;
        }
        const sale = entry.direction === 'output';
        const counterparty = sale ? body.data.customer : body.data.supplier;
        const taxId = counterparty.taxId.toUpperCase().replace(/\s+/g, '');
        let partner: D394Partner;
        let key: string;
        if (counterparty.country === 'RO' && /^RO\d+$/.test(taxId) && isValidCui(taxId)) {
          partner = { kind: 'registered', cui: taxId.slice(2), name: counterparty.name };
          key = `1|${partner.cui}`;
        } else if (!sale) {
          problems.push({
            code: 'D394_SUPPLIER',
            message: `Furnizorul ${counterparty.name} a facturat TVA fără cod de înregistrare în scopuri de TVA.`,
          });
          continue;
        } else if (isValidCnp(taxId) || (counterparty.country === 'RO' && isValidCui(taxId))) {
          partner = { kind: 'unregistered', code: taxId, name: counterparty.name };
          key = `2|${taxId}`;
        } else {
          // Without a code, the partner's address identifies it.
          const row = details.get(entry.partyId);
          const address = row ? (JSON.parse(row.details) as Party).address : undefined;
          if (!address || (address.country === 'RO' && !address.subdivision)) {
            problems.push({
              code: 'D394_ADDRESS',
              message: `Beneficiarul ${counterparty.name} nu are cod de identificare sau adresă cu județ.`,
            });
            continue;
          }
          partner = {
            kind: 'unregistered',
            name: counterparty.name,
            address: {
              country: address.country,
              ...(address.country === 'RO' && address.subdivision
                ? { county: address.subdivision }
                : {}),
              locality: address.city,
              street: address.lines.join(', '),
            },
          };
          key = `2|party:${entry.partyId}`;
        }
        // Acquisitions from a supplier applying VAT on collection are AI.
        const type = sale ? 'L' : supplierAppliesCashVat(entry.attributes.cashVat) ? 'AI' : 'A';
        const groupKey = `${type}|${rate}|${key}`;
        const group = groups.get(groupKey) ?? {
          type,
          rate,
          partner,
          documents: new Set<string>(),
          base: 0n,
          vat: 0n,
        };
        group.documents.add(entry.documentId!);
        group.base += entry.baseBani;
        group.vat += entry.taxBani;
        groups.set(groupKey, group);
      }

      // Series and storno invoices: those the engine issued, plus those declared outside it.
      const recorded = new Set(entries.map((entry) => entry.documentId));
      const seriesRows = new Map<
        string,
        { prefix: string; width: number; first: number; numbers: number[] }
      >();
      const invoices: D394Invoice[] = [];
      for (const { number, series: row } of issued) {
        if (!recorded.has(number.documentId))
          problems.push({
            code: 'D394_UNPOSTED',
            message: `Factura ${row.prefix}${String(number.number).padStart(row.width, '0')} emisă în perioadă nu este înregistrată în jurnalul de TVA.`,
          });
        const item = seriesRows.get(row.id) ?? {
          prefix: row.prefix,
          width: row.width,
          first: row.firstNumber,
          numbers: [],
        };
        item.numbers.push(number.number);
        seriesRows.set(row.id, item);
        if (number.typeCode === '381')
          invoices.push({
            type: 'storno',
            series: row.prefix,
            number: String(number.number).padStart(row.width, '0'),
          });
      }
      const issuedDocuments = new Set(issued.map((row) => row.number.documentId));
      const outside = [...recorded].filter(
        (id) =>
          id &&
          !issuedDocuments.has(id) &&
          [invoiceKinds.sale, invoiceKinds.saleCredit].includes(documents.get(id)?.kind as never),
      );
      if (outside.length && !options.outsideSeries)
        problems.push({
          code: 'D394_SERIES',
          message: `${outside.length} facturi emise în perioadă nu provin din seriile din registre: declarați seriile și numărul lor.`,
        });
      const pad = (value: number, width: number) => String(value).padStart(width, '0');
      const seriesList: D394InvoiceSeries[] = [...seriesRows.values()].flatMap(
        ({ prefix, width, first, numbers }) => [
          { type: 'allocated' as const, series: prefix, first: pad(first, width) },
          {
            type: 'issued' as const,
            series: prefix,
            first: pad(Math.min(...numbers), width),
            last: pad(Math.max(...numbers), width),
          },
        ],
      );
      if (options.outsideSeries) {
        seriesList.push(
          ...options.outsideSeries.allocated.map((item) => ({
            type: 'allocated' as const,
            ...item,
          })),
          ...options.outsideSeries.issued.map((item) => ({ type: 'issued' as const, ...item })),
        );
        invoices.push(
          ...options.outsideSeries.storno.map((item) => ({ type: 'storno' as const, ...item })),
        );
      }
      // The VAT collected (tvaCol) and deducted (tvaDed, tvaDedAI) on the invoices collected or
      // paid in the period, by rate, from the releases of VAT on collection.
      const paid = { collected: new Map(), deductible: new Map(), supplier: new Map() } as Record<
        'collected' | 'deductible' | 'supplier',
        Map<D394Rate, bigint>
      >;
      for (const entry of releases) {
        const rate = rateOf(entry.code);
        if (!rate) {
          problems.push({
            code: 'D394_OPERATION',
            message: `TVA la încasare cu codul ${entry.code} nu are încă un loc în declarație.`,
          });
          continue;
        }
        const [target, bani] =
          entry.direction === 'output'
            ? [paid.collected, entry.taxBani]
            : supplierAppliesCashVat(entry.attributes.cashVat)
              ? [paid.supplier, entry.deductibleBani]
              : [paid.deductible, entry.deductibleBani];
        target.set(rate, (target.get(rate) ?? 0n) + bani);
      }
      if (!cashSystem && (paid.collected.size || paid.deductible.size))
        problems.push({
          code: 'D394_CASH_VAT_EXIT',
          message:
            'Compania nu aplică TVA la încasare la sfârșitul perioadei, dar încasează sau plătește facturi din perioada în care l-a aplicat (art. 282 alin. (7) lit. b) din Codul fiscal): cum se declară această TVA în D394 nu este încă stabilit.',
        });
      if (problems.length || !seller || !roundToLeu)
        return { xml: '', inputs, problems, summary: null };
      const byRate = (values: Map<D394Rate, bigint>) =>
        Object.fromEntries(
          [...values].map(([rate, bani]) => [rate, Number(roundToLeu(bani))]),
        ) as Partial<Record<D394Rate, number>>;

      const company = JSON.parse(seller.details) as Party;
      const [row] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = company.address;
      const model: D394 = {
        period: statementPeriod(period),
        type: period.includes('Q') ? 'T' : 'L',
        company: {
          cui: row!.cui,
          caen: options.caen,
          name: company.name,
          address: [
            ...address.lines,
            address.city,
            address.subdivision
              ? (counties[address.subdivision] ?? address.subdivision)
              : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          phone: options.phone,
          ...(options.email ? { email: options.email } : {}),
        },
        representative: options.representative,
        preparer: options.preparer,
        consultation: options.consultation,
        ...(options.consultationChanged !== undefined
          ? { consultationChanged: options.consultationChanged }
          : {}),
        affiliates: options.affiliates,
        operations: [...groups.values()].map(({ documents: ids, base, vat, ...group }) => ({
          ...group,
          invoices: ids.size,
          base: Number(roundToLeu(base)),
          vat: Number(roundToLeu(vat)),
        })),
        simplified: {},
        series: seriesList,
        issuedInvoices: {
          own: issued.length + (options.outsideSeries?.invoices ?? 0),
          byBeneficiaries: 0,
          byThirdParties: 0,
        },
        invoices,
        cashVatDeductible: byRate(paid.supplier),
        ...(cashSystem
          ? {
              vatOnCollection: {
                collected: byRate(paid.collected),
                deductible: byRate(paid.deductible),
              },
            }
          : {}),
        ...(options.refund ? { refund: options.refund as D394['refund'] } : {}),
      };
      problems.push(
        ...checkD394(model)
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD394(model),
        inputs,
        problems,
        summary: {
          period,
          partners: model.operations.length,
          operations: model.operations.map((operation) => ({
            type: operation.type,
            rate: operation.rate,
            partner:
              operation.partner.kind === 'registered'
                ? operation.partner.cui
                : operation.partner.name,
            invoices: operation.invoices,
            base: operation.base,
            vat: operation.vat,
          })),
          issuedInvoices: model.issuedInvoices.own,
          ...(model.vatOnCollection ? { vatOnCollection: model.vatOnCollection } : {}),
          ...(Object.keys(model.cashVatDeductible).length
            ? { cashVatDeductible: model.cashVatDeductible }
            : {}),
        },
      };
    },
  };
}
