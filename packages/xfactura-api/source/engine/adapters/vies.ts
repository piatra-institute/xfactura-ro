import { z } from 'zod';
import type { LocalDate } from 'xfactura-core/time';

/**
 * VIES on-the-Web, the Commission's REST service (source EC/VIES, swagger_publicVAT.yaml):
 * `checkVatNumber` answers whether a Member State's VAT code is valid on the day asked, with the
 * name and address its register holds and, when the requester identifies itself with its own
 * code, a consultation number (requestIdentifier). It answers only for today: a code's status on
 * an earlier day is not asked of it. Answers are read strictly; anything but the documented
 * answer is an error, never a valid code. A live call is made only from a person's session.
 */
export const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

export type ViesQuery = {
  /** VIES's Member State code: EL for Greece, XI for Northern Ireland. */
  countryCode: string;
  vatNumber: string;
  /** The company's own code, for a consultation number: RO and its CUI. */
  requester?: { countryCode: string; vatNumber: string };
};

export type ViesAnswer = {
  /** The response exactly as received, kept as evidence. */
  raw: Uint8Array;
  result: {
    countryCode: string;
    vatNumber: string;
    requestDate: LocalDate;
    valid: boolean;
    name: string | null;
    address: string | null;
    requestIdentifier: string | null;
  };
};

/** VIES as the engine reads it. */
export interface ViesPort {
  check(query: ViesQuery): Promise<ViesAnswer>;
}

/** No usable answer: no response, an HTTP error, a Member State's register unavailable, or
 * content other than the documented one. */
export class ViesLookupFailed extends Error {}

const answer = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  vatNumber: z.string().min(1),
  requestDate: z.string().min(10),
  valid: z.boolean(),
  requestIdentifier: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
});
const failure = z.object({
  actionSucceed: z.literal(false),
  errorWrappers: z.array(z.object({ error: z.string(), message: z.string().optional() })),
});

/** VIES writes "---" for a name or address its register does not give. */
const given = (value: string | null | undefined) =>
  value && value.trim() && value.trim() !== '---' ? value.trim() : null;

/** Reads a checkVatNumber response; throws ViesLookupFailed on anything else. */
export function readViesAnswer(raw: Uint8Array, query: ViesQuery): ViesAnswer['result'] {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ViesLookupFailed('Răspunsul VIES nu este JSON.');
  }
  const failed = failure.safeParse(body);
  if (failed.success)
    throw new ViesLookupFailed(
      `VIES nu a putut verifica codul: ${failed.data.errorWrappers.map((item) => item.error).join(', ')}.`,
    );
  const parsed = answer.safeParse(body);
  if (!parsed.success) throw new ViesLookupFailed('Răspunsul VIES nu are forma documentată.');
  const result = parsed.data;
  if (result.countryCode !== query.countryCode || result.vatNumber !== query.vatNumber)
    throw new ViesLookupFailed(
      `VIES a răspuns despre ${result.countryCode}${result.vatNumber}, nu despre ${query.countryCode}${query.vatNumber}.`,
    );
  const day = result.requestDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new ViesLookupFailed('Răspunsul VIES nu are data cererii.');
  return {
    countryCode: result.countryCode,
    vatNumber: result.vatNumber,
    requestDate: day as LocalDate,
    valid: result.valid,
    name: given(result.name),
    address: given(result.address),
    requestIdentifier: given(result.requestIdentifier),
  };
}

/** The live service, over `fetch`. It never retries: a failed request is reported. */
export class ViesService implements ViesPort {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly options: {
      fetch?: typeof fetch;
      url?: string;
      /** Milliseconds before a request is abandoned as unanswered. */
      timeout?: number;
    } = {},
  ) {
    this.fetch = options.fetch ?? fetch;
  }

  async check(query: ViesQuery): Promise<ViesAnswer> {
    let response: Response;
    try {
      response = await this.fetch(this.options.url ?? VIES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          countryCode: query.countryCode,
          vatNumber: query.vatNumber,
          ...(query.requester
            ? {
                requesterMemberStateCode: query.requester.countryCode,
                requesterNumber: query.requester.vatNumber,
              }
            : {}),
        }),
        signal: AbortSignal.timeout(this.options.timeout ?? 30_000),
      });
    } catch (error) {
      throw new ViesLookupFailed(
        `VIES nu a răspuns: ${error instanceof Error ? error.message : 'eroare de rețea'}.`,
      );
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (!response.ok && response.status !== 400)
      throw new ViesLookupFailed(`VIES a răspuns cu HTTP ${response.status}.`);
    return { raw, result: readViesAnswer(raw, query) };
  }
}
