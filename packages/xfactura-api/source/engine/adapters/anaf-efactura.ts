import {
  EFacturaUnavailable,
  type EFacturaPort,
  type SpvMessage,
  type UploadStatus,
} from './efactura';

/**
 * ANAF's e-Factura web services over OAuth (MF/eFactura-API: "Prezentare servicii web pentru
 * Sistemul național privind factura electronică RO e-Factura"). The presentation gives the
 * endpoints, parameters and list fields; the upload and status replies' XML attributes
 * (index_incarcare, ExecutionStatus, stare, id_descarcare) and the list's paging fields follow
 * the services' Swagger pages, not yet in the source register, and are to be confirmed against a
 * recorded response.
 */
export type AnafEnvironment = 'test' | 'prod';

/** ANAF refused the request: it was received and not processed. */
export class EFacturaRefused extends Error {}
/** A documented call limit (MF/eFactura-limite) would be exceeded: nothing was sent. */
export class EFacturaRateLimited extends EFacturaUnavailable {}

const DAY_LIMITS = { status: 100, download: 10, list: 100_000 } as const;
const PER_MINUTE = 1000;

/** The date in Bucharest, the day ANAF's daily limits count. */
const bucharestDay = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(ms);

/** The limits ANAF publishes, kept by this process. */
export class CallLimits {
  private readonly calls: number[] = [];
  private readonly daily = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  /** Waits for room in the minute, then counts the call against its daily limit, if any. */
  async take(kind?: keyof typeof DAY_LIMITS, subject?: string) {
    if (kind) {
      const key = `${bucharestDay(this.now())}|${kind}|${subject}`;
      const used = this.daily.get(key) ?? 0;
      if (used >= DAY_LIMITS[kind])
        throw new EFacturaRateLimited(
          `Limita ANAF de ${DAY_LIMITS[kind]} apeluri pe zi pentru ${subject} a fost atinsă.`,
        );
      this.daily.set(key, used + 1);
    }
    for (;;) {
      const since = this.now() - 60_000;
      while (this.calls.length && this.calls[0]! <= since) this.calls.shift();
      if (this.calls.length < PER_MINUTE) break;
      await this.sleep(this.calls[0]! - since + 1);
    }
    this.calls.push(this.now());
  }
}

const kinds: Record<string, SpvMessage['kind']> = {
  'FACTURA TRIMISA': 'sent',
  'FACTURA PRIMITA': 'received',
  'ERORI FACTURA': 'error',
  'MESAJ CUMPARATOR PRIMIT / MESAJ CUMPARATOR TRANSMIS': 'buyer_message',
  'MESAJ CUMPARATOR PRIMIT': 'buyer_message',
  'MESAJ CUMPARATOR TRANSMIS': 'buyer_message',
};

/** data_creare, YYYYMMDDHHmm in Bucharest time, as epoch milliseconds. */
export function anafTimestamp(text: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (!match) throw new EFacturaRefused(`Dată ANAF necunoscută: ${text}.`);
  const [, y, m, d, h, min] = match.map(Number) as number[];
  const guess = Date.UTC(y!, m! - 1, d!, h!, min!);
  // The offset of Bucharest at that moment (EET or EEST).
  const local = new Date(guess).toLocaleString('en-US', {
    timeZone: 'Europe/Bucharest',
    hour12: false,
  });
  const shown = Date.parse(`${local} UTC`);
  return guess - (shown - guess);
}

const attribute = (xml: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];

export class AnafEFactura implements EFacturaPort {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly limits: CallLimits;

  constructor(
    private readonly options: {
      environment: AnafEnvironment;
      /** The OAuth access token (JWT) to call with for a CIF. */
      token: (cif: string) => Promise<string>;
      fetch?: typeof fetch;
      limits?: CallLimits;
      /** Milliseconds before a call is abandoned as unanswered. */
      timeout?: number;
    },
  ) {
    this.base = `https://api.anaf.ro/${options.environment}/FCTEL/rest`;
    this.fetch = options.fetch ?? fetch;
    this.limits = options.limits ?? new CallLimits();
  }

  private async call(cif: string, path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await this.fetch(`${this.base}/${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${await this.options.token(cif)}` },
        signal: AbortSignal.timeout(this.options.timeout ?? 60_000),
      });
    } catch (error) {
      throw new EFacturaUnavailable((error as Error).message);
    }
    if (response.status === 429)
      throw new EFacturaRateLimited('ANAF a refuzat apelul: prea multe apeluri.');
    if (response.status >= 500) throw new EFacturaUnavailable(`ANAF a răspuns ${response.status}.`);
    if (!response.ok)
      throw new EFacturaRefused(
        `ANAF a răspuns ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    return response;
  }

  async upload({ cif, xml }: { cif: string; xml: Uint8Array }) {
    await this.limits.take();
    const text = new TextDecoder().decode(xml);
    // CN for a credit note, UBL for an invoice; the CIF receives errors when the seller is unknown.
    const standard = /<(?:\w+:)?CreditNote[\s>]/.test(text) ? 'CN' : 'UBL';
    const response = await this.call(cif, `upload?standard=${standard}&cif=${cif}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    });
    const reply = await response.text();
    const index = attribute(reply, 'index_incarcare');
    if (attribute(reply, 'ExecutionStatus') !== '0' || !index)
      throw new EFacturaRefused(attribute(reply, 'errorMessage') ?? reply.slice(0, 500));
    return { uploadId: index };
  }

  async status({ cif, uploadId }: { cif: string; uploadId: string }): Promise<UploadStatus> {
    await this.limits.take('status', uploadId);
    const reply = await (await this.call(cif, `stareMesaj?id_incarcare=${uploadId}`)).text();
    const state = attribute(reply, 'stare');
    const messageId = attribute(reply, 'id_descarcare');
    if (state === 'ok' && messageId) return { state: 'ok', messageId };
    if (state === 'nok' && messageId) return { state: 'nok', messageId };
    if (state === 'in prelucrare') return { state: 'processing' };
    // Rejected at upload, or not this CIF's: there is nothing to follow.
    return { state: 'unknown' };
  }

  async messages({ cif, from, to, page }: { cif: string; from: number; to: number; page: number }) {
    await this.limits.take('list', cif);
    const reply = (await (
      await this.call(
        cif,
        `listaMesajePaginatieFactura?startTime=${from}&endTime=${to - 1}&cif=${cif}&pagina=${page}`,
      )
    ).json()) as {
      mesaje?: {
        data_creare: string;
        id_solicitare: string;
        detalii: string;
        tip: string;
        id: string;
      }[];
      numar_total_pagini?: number;
      eroare?: string;
    };
    if (reply.eroare) {
      // An empty window is reported as an error message.
      if (/nu exista mesaje/i.test(reply.eroare)) return { messages: [], pages: 0 };
      throw new EFacturaRefused(reply.eroare);
    }
    return {
      messages: (reply.mesaje ?? []).map((message): SpvMessage => {
        const kind = kinds[message.tip];
        if (!kind) throw new EFacturaRefused(`Tip de mesaj ANAF necunoscut: ${message.tip}.`);
        return {
          id: message.id,
          uploadId: message.id_solicitare,
          kind,
          createdAt: anafTimestamp(message.data_creare),
          details: message.detalii,
        };
      }),
      pages: reply.numar_total_pagini ?? 1,
    };
  }

  async download({ cif, messageId }: { cif: string; messageId: string }) {
    await this.limits.take('download', messageId);
    const response = await this.call(cif, `descarcare?id=${messageId}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** ANAF's OAuth endpoints (ANAF/OAuth: logincert.anaf.ro, authorization code, JWT tokens; the
 * access token is issued for 90 days, the refresh token for 365). */
export const anafOAuth = {
  authorize: 'https://logincert.anaf.ro/anaf-oauth2/v1/authorize',
  token: 'https://logincert.anaf.ro/anaf-oauth2/v1/token',
};

export type AnafClient = { clientId: string; clientSecret: string; redirectUri: string };
export type AnafTokens = { accessToken: string; refreshToken: string; expiresIn: number };

/** Where the company's representative signs in with their certificate; the engine never sees it. */
export function anafAuthorizeUrl(client: Omit<AnafClient, 'clientSecret'>, state: string) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    token_content_type: 'jwt',
    state,
  });
  return `${anafOAuth.authorize}?${query}`;
}

async function tokenRequest(client: AnafClient, body: Record<string, string>, http: typeof fetch) {
  let response: Response;
  try {
    response = await http(anafOAuth.token, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ ...body, token_content_type: 'jwt' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new EFacturaUnavailable((error as Error).message);
  }
  if (!response.ok)
    throw new EFacturaRefused(`ANAF a refuzat tokenul: ${(await response.text()).slice(0, 500)}`);
  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
  };
}

/** The authorization code, returned to the redirect URI, exchanged for tokens. */
export function anafExchangeCode(client: AnafClient, code: string, http: typeof fetch = fetch) {
  return tokenRequest(
    client,
    { grant_type: 'authorization_code', code, redirect_uri: client.redirectUri },
    http,
  );
}

export function anafRefresh(client: AnafClient, refreshToken: string, http: typeof fetch = fetch) {
  return tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken }, http);
}
