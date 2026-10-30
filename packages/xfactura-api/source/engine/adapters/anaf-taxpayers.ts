import { z } from 'zod';
import { isLocalDate, type LocalDate } from 'xfactura-core/time';

/**
 * ANAF's public web service on its registers of taxpayers, version 9 (source ANAF/WS-TVA-v9,
 * doc_WS_V9.txt): for each CUI on a date, the registers of VAT payers, of VAT on a cash basis,
 * of inactive and reactivated taxpayers, of split VAT and of RO e-Factura. It needs no
 * authentication. A request carries at most 100 CUIs, and a client sends at most one a second.
 * Answers are read strictly: live answers are reported to differ from the document at times
 * (an empty envelope on HTTP 200), and anything but the documented answer, in full, is an error,
 * never a taxpayer in good standing. Field shapes beyond the document are to be confirmed
 * against a recorded response.
 */
export const ANAF_TAXPAYERS_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
/** The most CUIs one request may carry. */
export const TAXPAYER_BATCH = 100;

export type TaxpayerQuery = { cui: string; date: LocalDate };

/** What the registers held about a CUI on the date asked. */
export type TaxpayerStatus = {
  name: string;
  vatPayer: boolean;
  /** VAT on a cash basis (TVA la încasare). */
  cashVat: boolean;
  /** In the register of inactive taxpayers on the date asked. */
  inactive: boolean;
  inactiveSince: LocalDate | null;
  reactivatedOn: LocalDate | null;
  splitVat: boolean;
  /** In the RO e-Factura register. */
  eInvoice: boolean;
  /** When the taxpayer was struck off, if it was. */
  struckOffOn: LocalDate | null;
};

/** ANAF's answer for one query; `status` is null when ANAF does not know the CUI. */
export type TaxpayerResult = TaxpayerQuery & { status: TaxpayerStatus | null };

/** One request's answer: its results, in the order asked, and the response exactly as received. */
export type TaxpayerAnswer = { raw: Uint8Array; results: TaxpayerResult[] };

/** ANAF's registers of taxpayers as the engine reads them. */
export interface TaxpayerRegistryPort {
  /**
   * The status of each CUI on its date, one answer per request sent. A request that fails ends
   * the lookup without a retry; the error carries the answers received before it.
   */
  lookup(queries: readonly TaxpayerQuery[]): Promise<TaxpayerAnswer[]>;
}

/** No usable answer: no response, an HTTP error, or content other than the documented one. */
export class TaxpayerLookupFailed extends Error {
  constructor(
    message: string,
    readonly answered: readonly TaxpayerAnswer[] = [],
  ) {
    super(message);
  }
}

// An absent date is an empty string.
const anafDate = z
  .union([z.literal(''), z.null(), z.iso.date()])
  .transform((value) => (value ? (value as LocalDate) : null));
const cui = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform((value) => String(value));
const found = z.object({
  date_generale: z.object({
    cui,
    data: z.iso.date(),
    denumire: z.string().min(1),
    statusRO_e_Factura: z.boolean(),
  }),
  inregistrare_scop_Tva: z.object({ scpTVA: z.boolean() }),
  inregistrare_RTVAI: z.object({ statusTvaIncasare: z.boolean() }),
  stare_inactiv: z.object({
    statusInactivi: z.boolean(),
    dataInactivare: anafDate,
    dataReactivare: anafDate,
    dataRadiere: anafDate,
  }),
  inregistrare_SplitTVA: z.object({ statusSplitTVA: z.boolean() }),
});
// The document lists the CUIs ANAF does not know; an entry may also name its date.
const notFound = z.union([cui, z.object({ cui, data: z.iso.date().optional() })]);
const envelope = z.object({
  cod: z.number(),
  message: z.string(),
  found: z.array(found),
  notFound: z.array(notFound),
});

const preview = (raw: Uint8Array) =>
  new TextDecoder().decode(raw.slice(0, 300)).replace(/\s+/g, ' ').trim();
const key = (cui: string, date: string) => `${cui}|${date}`;

/** Reads one v9 answer to `queries`: every query is answered, and nothing else is. */
export function parseTaxpayerAnswer(
  raw: Uint8Array,
  queries: readonly TaxpayerQuery[],
): TaxpayerResult[] {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new TaxpayerLookupFailed(`Răspunsul ANAF nu este JSON: ${preview(raw)}`);
  }
  const answer = envelope.safeParse(json);
  if (!answer.success) {
    const issue = answer.error.issues[0]!;
    throw new TaxpayerLookupFailed(
      `Răspunsul ANAF nu are forma documentată (v9): ${issue.path.join('.') || 'răspuns'}: ${issue.message}`,
    );
  }
  if (answer.data.cod !== 200)
    throw new TaxpayerLookupFailed(
      `ANAF a răspuns cu codul ${answer.data.cod}: ${answer.data.message.slice(0, 300)}`,
    );
  const asked = new Set(queries.map((query) => key(query.cui, query.date)));
  const statuses = new Map<string, TaxpayerStatus>();
  for (const entry of answer.data.found) {
    const id = key(entry.date_generale.cui, entry.date_generale.data);
    if (!asked.has(id) || statuses.has(id))
      throw new TaxpayerLookupFailed(
        `ANAF a răspuns despre CUI ${entry.date_generale.cui} la ${entry.date_generale.data}, care nu a fost întrebat sau apare de două ori.`,
      );
    statuses.set(id, {
      name: entry.date_generale.denumire,
      vatPayer: entry.inregistrare_scop_Tva.scpTVA,
      cashVat: entry.inregistrare_RTVAI.statusTvaIncasare,
      inactive: entry.stare_inactiv.statusInactivi,
      inactiveSince: entry.stare_inactiv.dataInactivare,
      reactivatedOn: entry.stare_inactiv.dataReactivare,
      splitVat: entry.inregistrare_SplitTVA.statusSplitTVA,
      eInvoice: entry.date_generale.statusRO_e_Factura,
      struckOffOn: entry.stare_inactiv.dataRadiere,
    });
  }
  const unknown = answer.data.notFound.map((item) =>
    typeof item === 'string' ? { cui: item, data: undefined } : item,
  );
  const covers = (item: (typeof unknown)[number], query: TaxpayerQuery) =>
    item.cui === query.cui && (item.data === undefined || item.data === query.date);
  for (const item of unknown)
    if (!queries.some((query) => covers(item, query)))
      throw new TaxpayerLookupFailed(`ANAF nu găsește CUI ${item.cui}, care nu a fost întrebat.`);
  return queries.map((query) => {
    const status = statuses.get(key(query.cui, query.date));
    if (status) return { ...query, status };
    if (unknown.some((item) => covers(item, query))) return { ...query, status: null };
    throw new TaxpayerLookupFailed(`ANAF nu a răspuns despre CUI ${query.cui} la ${query.date}.`);
  });
}

/** One request a second, as ANAF allows each client: requests wait their turn, in order. */
export class Pacer {
  private last = Number.NEGATIVE_INFINITY;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly interval = 1000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  /** Resolves when the next request may leave. */
  turn(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.last + this.interval - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}

/** The live service, over `fetch`. It never retries: a failed request is reported. */
export class AnafTaxpayers implements TaxpayerRegistryPort {
  private readonly fetch: typeof fetch;
  private readonly pacer: Pacer;

  constructor(
    private readonly options: {
      fetch?: typeof fetch;
      pacer?: Pacer;
      /** Milliseconds before a request is abandoned as unanswered. */
      timeout?: number;
    } = {},
  ) {
    this.fetch = options.fetch ?? fetch;
    this.pacer = options.pacer ?? new Pacer();
  }

  async lookup(queries: readonly TaxpayerQuery[]) {
    const unique = [
      ...new Map(queries.map((query) => [key(query.cui, query.date), query])).values(),
    ];
    for (const query of unique)
      if (!/^[1-9]\d{1,9}$/.test(query.cui) || !isLocalDate(query.date))
        throw new RangeError(`Not a CUI on a date: ${query.cui} ${query.date}.`);
    const answers: TaxpayerAnswer[] = [];
    for (let start = 0; start < unique.length; start += TAXPAYER_BATCH) {
      const batch = unique.slice(start, start + TAXPAYER_BATCH);
      try {
        answers.push(await this.request(batch));
      } catch (error) {
        throw new TaxpayerLookupFailed((error as Error).message, answers);
      }
    }
    return answers;
  }

  private async request(batch: TaxpayerQuery[]): Promise<TaxpayerAnswer> {
    await this.pacer.turn();
    let response: Response;
    let raw: Uint8Array;
    try {
      response = await this.fetch(ANAF_TAXPAYERS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch.map((query) => ({ cui: Number(query.cui), data: query.date }))),
        signal: AbortSignal.timeout(this.options.timeout ?? 30_000),
      });
      raw = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new TaxpayerLookupFailed(`ANAF nu a răspuns: ${(error as Error).message}`);
    }
    if (!response.ok)
      throw new TaxpayerLookupFailed(`ANAF a răspuns ${response.status}: ${preview(raw)}`);
    return { raw, results: parseTaxpayerAnswer(raw, batch) };
  }
}
