import { and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { allocate, parseMoney } from 'xfactura-core/money';
import { euVatPrefixes } from 'xfactura-core/ro/geo';
import { exemptCodes } from 'xfactura-core/ro/exempt';
import {
  customsDeclarationSchema,
  etransportObligation,
  goodsProofAnswer,
  intrastatFlows,
  isAcquisitionCode,
  isImportDeferredCode,
  isImportPaidCode,
  transportPresumption,
  viesDocumentKind,
  type ETransportFlow,
  type ETransportRule,
  type ExportProofRule,
  type SupplyRule,
  type TransportRule,
} from 'xfactura-core/ro/trade';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { addDays, bucharestDate, monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import { invoiceDocumentSchema } from 'xfactura-core/ubl/invoice-document';
import type { ObjectStore } from '../adapters/object-store';
import { ViesLookupFailed, type ViesPort } from '../adapters/vies';
import type { Transaction } from '../db/database';
import {
  companies,
  documents,
  entries,
  evidence,
  parties,
  proposalVersions,
  stockItems,
  taxEntries,
} from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import type { TradeWorkItem, WorkStep } from '../kernel/work';
import {
  causeFromQuestion,
  dateLabel,
  flowName,
  idLabel,
  periodLabel,
  textLabel,
} from '../kernel/work-names';
import type { Documents } from './documents';
import { standing } from './questions';

/*
 * Goods across the border (G3, core ro/trade) on the engine's side: VIES checks of partners'
 * codes, recorded as `vies.check` documents with VIES's answer kept as evidence; what the books
 * hold of an Intrastat declaration's lines; RO e-Transport's transports and their UIT codes; and
 * the worklist's items for proofs still pending and transports without a code.
 */

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const checkViesInput = z.object({ partyId: z.uuid() }).strict();
export const checkViesView = z.object({
  partyId: z.string(),
  documentId: z.string(),
  evidenceId: z.string(),
  countryCode: z.string(),
  vatNumber: z.string(),
  requestDate: z.string(),
  valid: z.boolean(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  requestIdentifier: z.string().nullable(),
});

export const intrastatDataInput = z.object({ month, flow: z.enum(intrastatFlows) }).strict();
const intrastatLine = z.object({
  documentId: z.string(),
  number: z.string().nullable(),
  partnerCountry: z.string(),
  /** Dispatches: the customer's VAT code in its Member State. */
  partnerVatId: z.string().nullable(),
  /** The CN8 code of the stock item, null when the line names none. */
  commodity: z.string().nullable(),
  description: z.string(),
  /** The invoiced value in lei, without decimals. */
  invoiceValue: z.string(),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  /** The declaration's fields the books do not hold. */
  missing: z.array(z.string()),
});
export const intrastatDataView = z.object({
  month: z.string(),
  flow: z.enum(intrastatFlows),
  lines: z.array(intrastatLine),
  total: z.string(),
  /** INS's XML format exists (intrastat4.xsd); the engine does not write it. */
  format: z.string(),
});

export const etransportListInput = z.object({ from: month, to: month }).strict();
const etransportRow = z.object({
  documentId: z.string(),
  number: z.string().nullable(),
  flow: z.enum(['acquisition', 'supply', 'import', 'export']),
  declarant: z.string(),
  start: z.string(),
  declareFrom: z.string(),
  declareBy: z.string(),
  validUntil: z.string(),
  status: z.enum(['missing', 'declared', 'not_required']),
  uit: z.string().nullable(),
});
export const etransportListView = z.object({
  items: z.array(etransportRow),
  next: z.string().nullable(),
  clauses: z.array(z.string()),
});

type Exempt = {
  documentId: string;
  number: string | null;
  code: string;
  taxPoint: string;
  attributes: Record<string, string>;
  partyId: string | null;
};

/** The goods across the border the books hold, by document: one row per standing entry. */
async function tradeEntries(tx: Transaction, companyId: string, from?: string, to?: string) {
  const rows = await tx
    .select({
      entryId: taxEntries.entryId,
      documentId: taxEntries.documentId,
      code: taxEntries.code,
      direction: taxEntries.direction,
      baseBani: taxEntries.baseBani,
      taxPoint: taxEntries.taxPoint,
      partyId: taxEntries.partyId,
      attributes: taxEntries.attributes,
      number: documents.number,
      proposalId: entries.proposalId,
      version: entries.version,
    })
    .from(taxEntries)
    .innerJoin(
      entries,
      and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
    )
    .leftJoin(
      documents,
      and(eq(documents.companyId, taxEntries.companyId), eq(documents.id, taxEntries.documentId)),
    )
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        or(
          inArray(taxEntries.code, [exemptCodes.intraCommunity, exemptCodes.export]),
          sql`${taxEntries.code} GLOB 'AIC-[0-9]*'`,
          sql`${taxEntries.code} GLOB 'IMP-[0-9]*'`,
          sql`${taxEntries.code} GLOB 'IMP-DEF-[0-9]*'`,
        ),
        entryStands('"acc_entries"'),
        ...(from ? [gte(taxEntries.taxPoint, from)] : []),
        ...(to ? [lte(taxEntries.taxPoint, to)] : []),
      ),
    )
    .orderBy(asc(taxEntries.taxPoint), asc(taxEntries.entryId));
  return rows.map((row) => ({
    ...row,
    attributes: JSON.parse(row.attributes) as Record<string, string>,
  }));
}

const flowOf = (code: string): ETransportFlow =>
  isAcquisitionCode(code)
    ? 'acquisition'
    : code === exemptCodes.intraCommunity
      ? 'supply'
      : isImportPaidCode(code) || isImportDeferredCode(code)
        ? 'import'
        : 'export';

export class Trade {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
    private readonly documents: Documents,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
    private readonly port?: ViesPort,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * `parties.checkVies`: asks VIES about a partner's code in another Member State, for today,
   * and records the answer as a `vies.check` document, VIES's response kept as its evidence.
   * Nothing is recorded when VIES gives no usable answer.
   */
  async checkVies(actor: Actor, key: string, input: z.infer<typeof checkViesInput>) {
    requireCondition(this.port, 'VIES_UNAVAILABLE', 'Serviciul VIES nu este configurat.', 503);
    const { party, cui } = await this.commands.read(actor, 'parties.checkVies', async (tx) => {
      const [row] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, actor.companyId), eq(parties.id, input.partyId)));
      requireCondition(row, 'NOT_FOUND', 'Partenerul nu este disponibil.', 404);
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      return { party: row, cui: company!.cui };
    });
    const prefix = euVatPrefixes[party.country];
    const code = (party.taxId ?? '').toUpperCase().replace(/[\s.-]+/g, '');
    requireCondition(
      prefix && party.country !== 'RO' && code.startsWith(prefix) && code.length > prefix.length,
      'VIES_CODE',
      `Partenerul ${party.name} (${party.country}) nu are un cod de TVA dintr-un alt stat membru (${prefix ?? '…'}…).`,
    );
    const query = {
      countryCode: prefix!,
      vatNumber: code.slice(prefix!.length),
      requester: { countryCode: 'RO', vatNumber: cui },
    };
    let answer: Awaited<ReturnType<ViesPort['check']>>;
    try {
      answer = await this.port.check(query);
    } catch (error) {
      if (!(error instanceof ViesLookupFailed)) throw error;
      requireCondition(false, 'VIES_UNAVAILABLE', error.message, 503);
      throw error;
    }
    return this.commands.run(actor, key, 'parties.checkVies', input, 'write', async (tx) => {
      const hash = sha256(answer.raw);
      const [stored] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
      let source = stored;
      if (!source) {
        await this.objects.put(actor.companyId, answer.raw, 1024 * 1024);
        const [row] = await tx
          .insert(evidence)
          .values({
            id: this.commands.ids(),
            companyId: actor.companyId,
            hash,
            filename: `vies-${query.countryCode}${query.vatNumber}-${answer.result.requestDate}.json`,
            mediaType: 'application/json',
            size: answer.raw.length,
            createdBy: actor.actorId,
            engineAt: this.commands.clock(),
          })
          .returning();
        source = row!;
      }
      const recorded = await this.documents.recordDerived(tx, actor, {
        kind: viesDocumentKind,
        body: { ...answer.result, source: 'vies_api' },
        source,
      });
      return {
        partyId: party.id,
        documentId: recorded.id,
        evidenceId: source.id,
        ...answer.result,
      };
    });
  }

  /**
   * `intrastat.data`: what the books hold of a month's Intrastat lines for a flow, by the month
   * the goods moved: each invoice line with its item's CN8 code and the invoiced value in lei; the
   * fields the declaration needs that the books do not hold (net mass, nature of transaction,
   * delivery terms, mode of transport, country of origin) are listed as missing.
   */
  intrastatData(actor: Actor, input: z.infer<typeof intrastatDataInput>) {
    return this.commands.read(actor, 'intrastat.data', async (tx) => {
      const from = `${input.month}-01`;
      const to = monthEnd(input.month as Month);
      const rows = (await tradeEntries(tx, actor.companyId)).filter(
        (row) =>
          row.direction === 'output' &&
          (input.flow === 'arrivals'
            ? isAcquisitionCode(row.code)
            : row.code === exemptCodes.intraCommunity) &&
          (row.attributes.supplied ?? row.taxPoint) >= from &&
          (row.attributes.supplied ?? row.taxPoint) <= to,
      );
      const lines: z.infer<typeof intrastatLine>[] = [];
      let total = 0n;
      for (const row of rows) {
        if (!row.documentId) continue;
        const [document] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.companyId, actor.companyId), eq(documents.id, row.documentId)));
        const body = invoiceDocumentSchema.safeParse(JSON.parse(document?.body ?? 'null'));
        if (!body.success) continue;
        const [version] = await tx
          .select({ input: proposalVersions.input })
          .from(proposalVersions)
          .where(
            and(
              eq(proposalVersions.companyId, actor.companyId),
              eq(proposalVersions.proposalId, row.proposalId),
              eq(proposalVersions.version, row.version),
            ),
          );
        const stock = (
          JSON.parse(version?.input ?? '{}') as {
            stock?: { lines: { line: string; itemId: string; quantity: string }[] };
          }
        ).stock;
        const items = stock?.lines.length
          ? await tx
              .select()
              .from(stockItems)
              .where(
                and(
                  eq(stockItems.companyId, actor.companyId),
                  inArray(
                    stockItems.id,
                    stock.lines.map((line) => line.itemId),
                  ),
                ),
              )
          : [];
        const weights = body.data.lines.map((line) => parseMoney(line.net, body.data.currency));
        const values = weights.some((weight) => weight !== 0n)
          ? allocate(row.baseBani, weights)
          : weights.map(() => 0n);
        const partner = input.flow === 'arrivals' ? body.data.supplier : body.data.customer;
        body.data.lines.forEach((line, index) => {
          const mapped = stock?.lines.find((item) => item.line === line.id);
          const item = mapped
            ? items.find((candidate) => candidate.id === mapped.itemId)
            : undefined;
          const value = values[index]!;
          total += value;
          lines.push({
            documentId: row.documentId!,
            number: row.number,
            partnerCountry: partner.country,
            partnerVatId: input.flow === 'dispatches' ? partner.taxId : null,
            commodity: item?.nc8 ?? null,
            description: line.description,
            invoiceValue: String((value + 50n) / 100n),
            quantity: mapped?.quantity ?? null,
            unit: item?.unit ?? null,
            missing: [
              ...(item?.nc8 ? [] : ['commodity']),
              'netMass',
              'natureOfTransaction',
              'deliveryTerms',
              'modeOfTransport',
              ...(input.flow === 'dispatches' ? ['countryOfOrigin'] : []),
            ],
          });
        });
      }
      return {
        month: input.month,
        flow: input.flow,
        lines,
        total: String((total + 50n) / 100n),
        format:
          'INS: Ghidul de implementare XML Intrastat 2026 (intrastat4.xsd); declarația se depune la INS în aplicația online, offline sau ca fișier XML, până pe 15 a lunii următoare.',
      };
    });
  }

  /** The transports the books hold, with who declares them in RO e-Transport and by when. */
  private async transports(tx: Transaction, companyId: string, from?: string, to?: string) {
    const rules = await this.rules(tx, companyId);
    const seen = new Set<string>();
    const rows: (z.infer<typeof etransportRow> & { period: string })[] = [];
    for (const row of await tradeEntries(tx, companyId, from, to)) {
      if (!row.documentId || seen.has(row.documentId)) continue;
      seen.add(row.documentId);
      const flow = flowOf(row.code);
      const start = (row.attributes.supplied ?? row.taxPoint) as LocalDate;
      let rule: ETransportRule;
      try {
        rule = rules.param<ETransportRule>('ro.etransport', 'reporting_period_start', start);
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        continue;
      }
      const window = etransportObligation(flow, start, rule);
      const found = await standing(tx, companyId, {
        kind: 'etransport.uit',
        subject: { kind: 'document', id: row.documentId },
        params: { flow, date: start },
      });
      const value = found.answered?.answer
        ? (JSON.parse(found.answered.answer.value) as { uit?: string; required?: false })
        : null;
      rows.push({
        documentId: row.documentId,
        number: row.number,
        flow,
        declarant: window.declarant,
        start: window.start,
        declareFrom: window.declareFrom,
        declareBy: window.declareBy,
        validUntil: window.validUntil,
        status: value ? (value.uit ? 'declared' : 'not_required') : 'missing',
        uit: value?.uit ?? null,
        period: start.slice(0, 7),
      });
    }
    return rows;
  }

  /** `etransport.list`: the transports of a range of months and their UIT codes. */
  etransportList(actor: Actor, input: z.infer<typeof etransportListInput>) {
    return this.commands.read(actor, 'etransport.list', async (tx) => ({
      items: (
        await this.transports(tx, actor.companyId, `${input.from}-01`, monthEnd(input.to as Month))
      ).map(({ period: _period, ...row }) => row),
      next: null,
      clauses: ['OUG41/2022:art.8', 'OUG41/2022:art.11', 'OUG41/2022:consolidat'],
    }));
  }

  /** The worklist's items: proofs pending and transports without a UIT code. */
  async work(tx: Transaction, companyId: string, today: LocalDate): Promise<TradeWorkItem[]> {
    const items: TradeWorkItem[] = [];
    const rules = await this.rules(tx, companyId);
    for (const row of await tradeEntries(tx, companyId)) {
      if (
        row.direction !== 'output' ||
        (row.code !== exemptCodes.intraCommunity && row.code !== exemptCodes.export) ||
        row.attributes.proof !== 'pending' ||
        !row.documentId
      )
        continue;
      const exempt: Exempt = {
        documentId: row.documentId,
        number: row.number,
        code: row.code,
        taxPoint: row.taxPoint,
        attributes: row.attributes,
        partyId: row.partyId,
      };
      const item = await this.proofItem(tx, companyId, rules, exempt, today);
      if (item) items.push(item);
    }
    for (const row of await this.transports(tx, companyId)) {
      if (row.status !== 'missing') continue;
      const request = {
        kind: 'etransport.uit' as const,
        subject: { kind: 'document', id: row.documentId },
        params: { flow: row.flow, date: row.start },
      };
      const message = `Transportul documentului ${row.number ?? row.documentId} (${flowName(row.flow)}, ${row.start}) nu are cod UIT RO e-Transport înregistrat: dacă bunurile sunt cu risc fiscal ridicat, ${row.declarant} declară datele între ${row.declareFrom} și ${row.declareBy} (OUG nr. 41/2022 art. 8, 11); altfel indicați motivul.`;
      items.push({
        kind: 'etransport.uit',
        subject: { kind: 'document', id: row.documentId },
        severity: 'warn',
        due: row.declareBy,
        period: row.period,
        message,
        causes: [causeFromQuestion(request, message)],
        details: { ...row },
        labels: {
          documentId: idLabel('Document', 'document'),
          number: textLabel('Număr'),
          flow: textLabel('Flux'),
          declarant: textLabel('Declarant'),
          period: periodLabel('Perioadă'),
          start: dateLabel('Data începerii'),
          declareFrom: dateLabel('Declarare de la'),
          declareBy: dateLabel('Termen declarare'),
          validUntil: dateLabel('Valabil până la'),
          uit: textLabel('Cod UIT'),
          status: textLabel('Stare'),
        },
        next: [
          {
            operation: 'questions.ask',
            by: 'agent',
            inputHint: request,
          },
          { operation: 'questions.answer', by: 'human', inputHint: {} },
        ],
      });
    }
    return items;
  }

  /** A posted exempt supply's pending proof, unless a person's answer now justifies it. */
  private async proofItem(
    tx: Transaction,
    companyId: string,
    rules: RuleContext,
    row: Exempt,
    today: LocalDate,
  ): Promise<TradeWorkItem | null> {
    const basis = row.code === exemptCodes.intraCommunity ? 'intra_eu' : 'export';
    const supplied = (row.attributes.supplied ?? row.taxPoint) as LocalDate;
    let due = row.attributes.proofDue as LocalDate | undefined;
    try {
      if (!due)
        due = addDays(
          supplied,
          basis === 'intra_eu'
            ? rules.param<SupplyRule>('ro.vat.intra_eu.supply', 'vat_chargeability_date', supplied)
                .proofDays
            : rules.param<ExportProofRule>(
                'ro.vat.export.proof',
                'vat_chargeability_date',
                supplied,
              ).proofDays,
        );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return null;
    }
    const request = {
      kind: 'goods.proof',
      subject: { kind: 'document', id: row.documentId },
      params: { basis, supplied, due },
    };
    const found = await standing(tx, companyId, request);
    let reason = 'nicio dovadă înregistrată';
    if (found.answered?.answer) {
      const answer = goodsProofAnswer.safeParse(JSON.parse(found.answered.answer.value));
      if (answer.success && answer.data.basis === 'intra_eu') {
        const rule = rules.param<TransportRule>(
          'ro.vat.intra_eu.transport',
          'vat_chargeability_date',
          supplied,
        );
        const verdict = transportPresumption(
          answer.data.transport,
          row.attributes.counterpartyCountry ?? '',
          supplied,
          rule,
        );
        if (
          verdict.presumed ||
          (rule.presumption === 'safe_harbour' && answer.data.transport.documents.length)
        )
          return null;
        reason = verdict.reasons.join(' ');
      } else if (answer.success && answer.data.basis === 'export') {
        const [declaration] = await tx
          .select()
          .from(documents)
          .where(
            and(eq(documents.companyId, companyId), eq(documents.id, answer.data.declarationId)),
          );
        const parsed = customsDeclarationSchema.safeParse(JSON.parse(declaration?.body ?? 'null'));
        if (parsed.success && parsed.data.procedure === 'export' && parsed.data.exit) return null;
        reason = 'declarația indicată nu este una de export cu ieșirea certificată';
      }
    }
    const late = today > due;
    const message = late
      ? `Termenul de ${basis === 'intra_eu' ? 'dovadă a transportului' : 'certificare a ieșirii'} pentru ${row.number ?? row.documentId} a trecut (${due}): fără documente, livrarea nu este scutită și TVA se colectează de la faptul generator (OMFP nr. 103/2016 art. 1 alin. (7)); ${reason}.`
      : `${basis === 'intra_eu' ? 'Livrarea intracomunitară' : 'Exportul'} ${row.number ?? row.documentId} din ${supplied} așteaptă ${basis === 'intra_eu' ? 'documentele transportului' : 'certificarea ieșirii'} până la ${due} (OMFP nr. 103/2016 art. 1 alin. (4)); ${reason}.`;
    return {
      kind: 'goods.proof',
      subject: { kind: 'document', id: row.documentId },
      severity: late ? 'block' : 'warn',
      due,
      period: supplied.slice(0, 7),
      message,
      causes: [causeFromQuestion(request, message)],
      details: { basis, supplied, due, code: row.code, number: row.number },
      labels: {
        basis: textLabel('Temei'),
        supplied: dateLabel('Data livrării'),
        due: dateLabel('Termen'),
        code: textLabel('Cod'),
        number: textLabel('Număr'),
      },
      next: [
        {
          operation: 'questions.ask',
          by: 'agent',
          inputHint: request as unknown as WorkStep['inputHint'],
        },
        { operation: 'questions.answer', by: 'human', inputHint: {} },
      ],
    };
  }

  /** Today in Bucharest, for the reads. */
  today() {
    return bucharestDate(this.clock());
  }
}
