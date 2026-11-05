import { z } from 'zod';
import type { Issue, JsonValue, Loaded } from '../../kernel';
import { addDays, isLocalDate, type LocalDate } from '../../time';
import { viesCheckSchema, viesDocumentKind, type ViesCheck } from './documents';
import type { TransportRule, ViesRule } from './parameters';

/*
 * The proof of an intra-community supply of goods (art. 294 alin. (2) lit. a); OMFP nr. 103/2016
 * art. 10): the buyer's VAT code valid in VIES, and the transport to another Member State, which
 * Regulation (EU) No 282/2011 art. 45a presumes from two non-contradictory items of evidence
 * issued by two parties independent of the seller, of the buyer and of each other. The engine
 * reads what the documents show; it never presumes a transport the evidence does not give.
 */

const day = z.string().refine((value): boolean => isLocalDate(value), 'Dată invalidă.');

/** Art. 45a alin. (3): lit. (a) the transport's own documents, lit. (b) the others. */
export const transportDocumentKinds = {
  /** Lit. (a). */
  cmr: 'a',
  bill_of_lading: 'a',
  air_waybill: 'a',
  carrier_invoice: 'a',
  /** Lit. (b) pct. (i)–(iii). */
  insurance: 'b',
  bank_payment: 'b',
  public_authority: 'b',
  warehouse_receipt: 'b',
} as const;
export type TransportDocumentKind = keyof typeof transportDocumentKinds;

export const transportProofInput = z
  .object({
    /** Who dispatched or transported the goods, or a third party on whose behalf (art. 45a alin.
     * (1) lit. (a) the seller, lit. (b) the buyer). */
    by: z.enum(['seller', 'buyer']),
    documents: z
      .array(
        z
          .object({
            kind: z.enum(
              Object.keys(transportDocumentKinds) as [
                TransportDocumentKind,
                ...TransportDocumentKind[],
              ],
            ),
            evidenceId: z.uuid(),
            /** Who issued it: a carrier, insurer, bank, notary, warehouse keeper. */
            issuer: z.string().trim().min(2).max(300),
            /** Independent of the seller and of the buyer (not either of them, not their own
             * transport, not an affiliate): the reviewer confirms. */
            independent: z.boolean(),
            /** The Member State it shows the goods went to (arrived in, stored in). */
            destination: z.string().regex(/^[A-Z]{2}$/),
            date: day,
          })
          .strict(),
      )
      .max(10),
    /** Art. 45a alin. (1) lit. (b) pct. (i): the buyer's written statement, when the buyer
     * transported the goods. */
    buyerStatement: z
      .object({
        evidenceId: z.uuid(),
        receivedOn: day,
        destination: z.string().regex(/^[A-Z]{2}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TransportProof = z.infer<typeof transportProofInput>;

/** What the evidence shows of art. 45a: the presumption met, or why not. */
export interface TransportVerdict {
  presumed: boolean;
  reasons: string[];
  /** The documents counted toward the presumption. */
  counted: string[];
}

/** The buyer's statement is due by the `day`th of the month after the supply. */
export function statementDeadline(supplied: LocalDate, day: number): LocalDate {
  const [year, month] = supplied.split('-').map(Number) as [number, number];
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return `${next}-${String(day).padStart(2, '0')}` as LocalDate;
}

/**
 * Art. 45a alin. (1): at least two non-contradictory items of lit. (a), or one of lit. (a) with
 * one of lit. (b), issued by two different parties independent of the seller, of the buyer and of
 * each other; for a transport by the buyer, its written statement too, by the 10th of the next
 * month. Items that disagree on the destination contradict each other.
 */
export function transportPresumption(
  proof: TransportProof,
  destination: string,
  supplied: LocalDate,
  rule: TransportRule,
): TransportVerdict {
  const reasons: string[] = [];
  const destinations = new Set(proof.documents.map((item) => item.destination));
  if (proof.buyerStatement) destinations.add(proof.buyerStatement.destination);
  if (destinations.size > 1)
    reasons.push(
      `Documentele se contrazic asupra statului de destinație (${[...destinations].join(', ')}).`,
    );
  else if (destinations.size === 1 && !destinations.has(destination))
    reasons.push(
      `Documentele arată sosirea în ${[...destinations][0]}, nu în statul cumpărătorului (${destination}).`,
    );
  const independent = proof.documents.filter((item) => item.independent);
  if (independent.length < proof.documents.length)
    reasons.push(
      'Unele documente sunt emise de vânzător, de cumpărător sau de o parte legată de ei: nu se numără (art. 45a alin. (1)).',
    );
  // Two different issuers, at least one of the transport's own documents.
  const byIssuer = new Map<string, (typeof independent)[number]>();
  for (const item of [...independent].sort((a, b) =>
    transportDocumentKinds[a.kind].localeCompare(transportDocumentKinds[b.kind]),
  ))
    if (!byIssuer.has(item.issuer.toUpperCase())) byIssuer.set(item.issuer.toUpperCase(), item);
  const counted = [...byIssuer.values()];
  const own = counted.filter((item) => transportDocumentKinds[item.kind] === 'a');
  if (counted.length < rule.documents || own.length < 1)
    reasons.push(
      `Sunt necesare cel puțin ${rule.documents} dovezi de la emitenți diferiți și independenți, dintre care cel puțin una a transportului (CMR semnat, conosament, factură de transport aerian sau a transportatorului); există ${counted.length}, ${own.length} a transportului.`,
    );
  if (proof.by === 'buyer') {
    const due = statementDeadline(supplied, rule.buyerStatementDay);
    if (!proof.buyerStatement)
      reasons.push(
        'Cumpărătorul a transportat bunurile: este necesară declarația lui scrisă privind statul de destinație (art. 45a alin. (1) lit. (b) pct. (i)).',
      );
    else if (proof.buyerStatement.receivedOn > due)
      reasons.push(
        `Declarația cumpărătorului a fost primită la ${proof.buyerStatement.receivedOn}, după ${due} (a ${rule.buyerStatementDay}-a zi a lunii următoare livrării).`,
      );
  }
  return {
    presumed: reasons.length === 0,
    reasons,
    counted: counted.map((item) => item.evidenceId),
  };
}

/** The evidence a proof cites, for the read plan. */
export const proofEvidence = (proof: TransportProof | undefined) =>
  proof
    ? [
        ...proof.documents.map((item) => item.evidenceId),
        ...(proof.buyerStatement ? [proof.buyerStatement.evidenceId] : []),
      ]
    : [];

/** The VIES state code of a VAT code's prefix (Greece writes EL in both). */
export const viesCountry = (prefix: string) => prefix;

/** A VIES document as the treatment reads it, or why it cannot. */
export function viesOf(
  loaded: Loaded,
  documentId: string,
): { check: ViesCheck; evidenceId: string | null } | Issue {
  const record = loaded.documents.get(documentId);
  if (!record || record.kind !== viesDocumentKind)
    return {
      code: 'VIES_DOCUMENT',
      severity: 'block',
      message:
        'Indicați verificarea VIES a codului de TVA al cumpărătorului (un document vies.check).',
      path: 'viesDocumentId',
    };
  return { check: viesCheckSchema.parse(record.body), evidenceId: record.evidenceId };
}

/**
 * Whether a VIES answer justifies the buyer's code for a supply: the same code, valid, dated by
 * the chargeability (or the supply, by the rule) and not before the supply's month; an answer
 * dated after the supply is the reviewer's to confirm.
 */
export function viesVerdict(
  check: ViesCheck,
  code: string,
  supplied: LocalDate,
  exigibility: LocalDate,
  rule: ViesRule,
): Issue[] {
  const issues: Issue[] = [];
  const details: JsonValue = {
    countryCode: check.countryCode,
    vatNumber: check.vatNumber,
    requestDate: check.requestDate,
    valid: check.valid,
    ...(check.requestIdentifier ? { requestIdentifier: check.requestIdentifier } : {}),
  };
  if (`${check.countryCode}${check.vatNumber}` !== code)
    issues.push({
      code: 'VIES_CODE',
      severity: 'block',
      message: `Verificarea VIES privește ${check.countryCode}${check.vatNumber}, nu codul de pe factură (${code}).`,
      details,
    });
  if (!check.valid)
    issues.push({
      code: 'VIES_INVALID',
      severity: 'block',
      message: `VIES arată codul ${check.countryCode}${check.vatNumber} nevalid la ${check.requestDate}: livrarea nu este scutită ca livrare intracomunitară (art. 294 alin. (2) lit. a)); facturați-o cu TVA sau verificați din nou codul.`,
      details,
    });
  const by = rule.checkBy === 'supply' ? supplied : exigibility;
  if (check.requestDate > by)
    issues.push({
      code: 'VIES_LATE',
      severity: 'block',
      message: `Codul a fost verificat în VIES la ${check.requestDate}, după ${rule.checkBy === 'supply' ? 'livrare' : 'exigibilitate'} (${by}): verificați-l pentru data operațiunii.`,
      details,
    });
  else if (check.requestDate > supplied)
    issues.push({
      code: 'VIES_AFTER_SUPPLY',
      severity: 'ack',
      message: `Codul a fost verificat în VIES la ${check.requestDate}, după livrarea din ${supplied} și înainte de exigibilitate (${exigibility}): confirmați că era valabil la livrare.`,
      details,
    });
  else if (check.requestDate < addDays(supplied, -31))
    issues.push({
      code: 'VIES_STALE',
      severity: 'ack',
      message: `Ultima verificare VIES (${check.requestDate}) este cu mai mult de o lună înaintea livrării (${supplied}): confirmați că, la livrare, codul era încă valabil.`,
      details,
    });
  return issues;
}
