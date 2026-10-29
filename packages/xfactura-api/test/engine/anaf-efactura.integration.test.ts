import { afterAll, describe, expect, test } from 'bun:test';
import {
  AnafEFactura,
  anafAuthorizeUrl,
  anafExchangeCode,
  anafTimestamp,
  CallLimits,
  EFacturaRateLimited,
  EFacturaRefused,
} from '../../source/engine/adapters/anaf-efactura';
import { EFacturaUnavailable } from '../../source/engine/adapters/efactura';
import { anafConnections } from '../../source/engine/db/schema';
import { FakeEFactura } from './fakes/efactura';
import { salesCompany } from './fixtures/sales';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Call = { method: string; url: string; authorization: string | null; body: string };

/** ANAF's e-Factura API as the presentation documents it, answering from a script. */
function anaf(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      authorization: new Headers(init?.headers).get('Authorization'),
      body:
        typeof init?.body === 'string' || init?.body instanceof URLSearchParams
          ? String(init.body)
          : '',
    };
    calls.push(call);
    const route = Object.keys(routes).find((path) => new URL(url).pathname.endsWith(path));
    if (!route) return new Response('not found', { status: 404 });
    return routes[route]!(call);
  }) as typeof fetch;
  return { calls, http };
}

const xml = (body: string) =>
  new Response(body, { headers: { 'Content-Type': 'application/xml' } });
const client = (http: typeof fetch, limits?: CallLimits) =>
  new AnafEFactura({
    environment: 'test',
    token: async () => 'jwt-token',
    fetch: http,
    ...(limits ? { limits } : {}),
  });
const invoice = new TextEncoder().encode(
  '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>',
);
const creditNote = new TextEncoder().encode(
  '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/>',
);

describe('ANAF e-Factura client', () => {
  test('uploads with the OAuth token and the standard of the document', async () => {
    const { calls, http } = anaf({
      '/upload': () =>
        xml(
          '<header xmlns="mfp:anaf:dgti:spv:respUploadFisier:v1" ExecutionStatus="0" index_incarcare="5001"/>',
        ),
    });
    expect(await client(http).upload({ cif: '18547290', xml: invoice })).toEqual({
      uploadId: '5001',
    });
    await client(http).upload({ cif: '18547290', xml: creditNote });
    expect(calls.map((call) => [call.method, call.url, call.authorization])).toEqual([
      [
        'POST',
        'https://api.anaf.ro/test/FCTEL/rest/upload?standard=UBL&cif=18547290',
        'Bearer jwt-token',
      ],
      [
        'POST',
        'https://api.anaf.ro/test/FCTEL/rest/upload?standard=CN&cif=18547290',
        'Bearer jwt-token',
      ],
    ]);
  });

  test('a refusal is ANAF’s answer; a lost connection is unavailable', async () => {
    const refused = anaf({
      '/upload': () =>
        xml(
          '<header ExecutionStatus="1"><Errors errorMessage="Fisierul nu este XML valid"/></header>',
        ),
    });
    expect(client(refused.http).upload({ cif: '18547290', xml: invoice })).rejects.toThrow(
      new EFacturaRefused('Fisierul nu este XML valid'),
    );
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(client(down).upload({ cif: '18547290', xml: invoice })).rejects.toBeInstanceOf(
      EFacturaUnavailable,
    );
    const busy = anaf({ '/stareMesaj': () => new Response('', { status: 503 }) });
    expect(client(busy.http).status({ cif: '18547290', uploadId: '5001' })).rejects.toBeInstanceOf(
      EFacturaUnavailable,
    );
  });

  test('reads the processing state of an upload', async () => {
    const replies = [
      'stare="ok" id_descarcare="9001"',
      'stare="nok" id_descarcare="9002"',
      'stare="in prelucrare"',
      'stare="XML cu erori nepreluat de sistem"',
    ];
    const { http } = anaf({ '/stareMesaj': () => xml(`<header ${replies.shift()}/>`) });
    const port = client(http);
    const status = () => port.status({ cif: '18547290', uploadId: '5001' });
    expect([await status(), await status(), await status(), await status()]).toEqual([
      { state: 'ok', messageId: '9001' },
      { state: 'nok', messageId: '9002' },
      { state: 'processing' },
      { state: 'unknown' },
    ]);
  });

  test('lists messages by page, in Bucharest time, and an empty window as none', async () => {
    const pages = [
      {
        mesaje: [
          {
            data_creare: '202610281452',
            cif: '18547290',
            id_solicitare: '5001',
            detalii: 'Factura cu id_incarcare=5001',
            tip: 'FACTURA TRIMISA',
            id: '9001',
          },
          {
            data_creare: '202607011000',
            cif: '18547290',
            id_solicitare: '6001',
            detalii: 'Factura primita',
            tip: 'FACTURA PRIMITA',
            id: '9101',
          },
        ],
        numar_total_pagini: 2,
      },
      { eroare: 'Nu exista mesaje in intervalul selectat', titlu: 'Lista Mesaje' },
    ];
    const { calls, http } = anaf({
      '/listaMesajePaginatieFactura': () => Response.json(pages.shift()),
    });
    const port = client(http);
    const first = await port.messages({ cif: '18547290', from: 1000, to: 2000, page: 1 });
    expect(first.pages).toBe(2);
    expect(
      first.messages.map((message) => [
        message.kind,
        message.uploadId,
        new Date(message.createdAt).toISOString(),
      ]),
    ).toEqual([
      // 28 October: winter time, UTC+2; 1 July: summer time, UTC+3.
      ['sent', '5001', '2026-10-28T12:52:00.000Z'],
      ['received', '6001', '2026-07-01T07:00:00.000Z'],
    ]);
    expect(await port.messages({ cif: '18547290', from: 1000, to: 2000, page: 2 })).toEqual({
      messages: [],
      pages: 0,
    });
    expect(calls[0]!.url).toBe(
      'https://api.anaf.ro/test/FCTEL/rest/listaMesajePaginatieFactura?startTime=1000&endTime=1999&cif=18547290&pagina=1',
    );
  });

  test('keeps ANAF’s daily limits per message, and waits for room in the minute', async () => {
    let now = Date.parse('2026-10-29T09:00:00Z');
    const slept: number[] = [];
    const limits = new CallLimits(
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    const { calls, http } = anaf({ '/descarcare': () => new Response(new Uint8Array([1, 2, 3])) });
    const port = client(http, limits);
    for (let index = 0; index < 10; index += 1)
      expect(await port.download({ cif: '18547290', messageId: '9001' })).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    expect(port.download({ cif: '18547290', messageId: '9001' })).rejects.toBeInstanceOf(
      EFacturaRateLimited,
    );
    expect(calls).toHaveLength(10);
    // The next day in Bucharest the message can be downloaded again.
    now = Date.parse('2026-10-29T22:30:00Z');
    await port.download({ cif: '18547290', messageId: '9001' });
    // A thousand calls fill the minute; the next waits for the oldest to leave it.
    for (let index = 0; index < 999; index += 1) await limits.take();
    await limits.take();
    expect(slept).toHaveLength(1);
  });

  test('builds the authorization address and exchanges the code for tokens', async () => {
    const app = {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.example/anaf',
    };
    const url = new URL(anafAuthorizeUrl(app, 'state-1'));
    expect([url.origin + url.pathname, Object.fromEntries(url.searchParams)]).toEqual([
      'https://logincert.anaf.ro/anaf-oauth2/v1/authorize',
      {
        response_type: 'code',
        client_id: 'client',
        redirect_uri: 'https://app.example/anaf',
        token_content_type: 'jwt',
        state: 'state-1',
      },
    ]);
    const { calls, http } = anaf({
      '/token': () =>
        Response.json({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 7776000,
          token_type: 'Bearer',
        }),
    });
    expect(await anafExchangeCode(app, 'code-1', http)).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 7776000,
    });
    expect(calls[0]!.authorization).toBe(
      `Basic ${Buffer.from('client:secret').toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://app.example/anaf',
      token_content_type: 'jwt',
    });
  });

  test('reads ANAF’s creation times', () => {
    expect(new Date(anafTimestamp('202601151230')).toISOString()).toBe('2026-01-15T10:30:00.000Z');
    expect(() => anafTimestamp('2026-01-15')).toThrow(EFacturaRefused);
  });
});

/** The simulated ANAF behind the HTTP shapes the client reads: the engine's SPV flow over it. */
function simulatedAnaf(fake: FakeEFactura) {
  const minute = (ms: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Bucharest',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(ms)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
  };
  const tip = {
    sent: 'FACTURA TRIMISA',
    received: 'FACTURA PRIMITA',
    error: 'ERORI FACTURA',
    buyer_message: 'MESAJ CUMPARATOR PRIMIT / MESAJ CUMPARATOR TRANSMIS',
  };
  return anaf({
    '/upload': async (call) => {
      const { uploadId } = await fake.upload({
        cif: new URL(call.url).searchParams.get('cif')!,
        xml: new TextEncoder().encode(call.body),
      });
      return xml(`<header ExecutionStatus="0" index_incarcare="${uploadId}"/>`);
    },
    '/stareMesaj': async (call) => {
      const status = await fake.status({
        cif: '',
        uploadId: new URL(call.url).searchParams.get('id_incarcare')!,
      });
      return xml(
        status.state === 'ok' || status.state === 'nok'
          ? `<header stare="${status.state}" id_descarcare="${status.messageId}"/>`
          : `<header stare="${status.state === 'processing' ? 'in prelucrare' : 'XML cu erori nepreluat de sistem'}"/>`,
      );
    },
    '/listaMesajePaginatieFactura': async (call) => {
      const query = new URL(call.url).searchParams;
      const page = await fake.messages({
        cif: query.get('cif')!,
        from: Number(query.get('startTime')),
        to: Number(query.get('endTime')) + 1,
        page: Number(query.get('pagina')),
      });
      if (!page.messages.length)
        return Response.json({ eroare: 'Nu exista mesaje in intervalul selectat' });
      return Response.json({
        mesaje: page.messages.map((message) => ({
          data_creare: minute(message.createdAt),
          id_solicitare: message.uploadId,
          detalii: message.details,
          tip: tip[message.kind],
          id: message.id,
        })),
        numar_total_pagini: page.pages,
      });
    },
    '/descarcare': async (call) =>
      new Response(
        Buffer.from(
          await fake.download({ cif: '', messageId: new URL(call.url).searchParams.get('id')! }),
        ),
      ),
  });
}

describe('the SPV flow over the live client', () => {
  test('an issued invoice is uploaded, accepted, and matched in the inbox', async () => {
    const fake = new FakeEFactura();
    const { http } = simulatedAnaf(fake);
    const s = await scenario({
      efactura: new AnafEFactura({
        environment: 'test',
        token: async () => 'jwt-token',
        fetch: http,
      }),
      clock: () => fake.now,
    });
    open.push(s);
    const { issue } = await salesCompany(s);
    const invoice = await issue();
    const submitted = await s.invoke<{ id: string; state: string; uploadId: string }>(
      s.owner,
      'spv.submit',
      {
        documentId: invoice.documentId,
      },
    );
    expect(submitted.state).toBe('submitted');
    expect(await s.invoke(s.owner, 'spv.refresh', { submissionId: submitted.id })).toMatchObject({
      state: 'accepted',
    });
    fake.advance(120_000);
    const synced = await s.invoke<{ outcomes: Record<string, number> }>(s.owner, 'spv.sync', {
      from: '2026-03-10T00:00:00Z',
      to: new Date(fake.now).toISOString(),
    });
    expect(synced.outcomes).toEqual({ matched: 1 });
  });
});

describe('connecting a company to ANAF', () => {
  const app = {
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://app.example/anaf',
  };

  test('is refused while the application is not registered with ANAF', async () => {
    const s = await scenario();
    open.push(s);
    expect((await s.refused(s.invoke(s.owner, 'spv.connect.start')))?.code).toBe(
      'ANAF_NOT_CONFIGURED',
    );
  });

  test('keeps the tokens sealed, calls with them, and renews them before they expire', async () => {
    const fake = new FakeEFactura();
    const simulated = simulatedAnaf(fake);
    const grants: Record<string, string>[] = [];
    let issued = 0;
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://logincert.anaf.ro/')) {
        grants.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
        issued += 1;
        return Response.json({
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued}`,
          expires_in: 90 * 86400,
        });
      }
      return simulated.http(input, init);
    }) as typeof fetch;
    const s = await scenario({
      efactura: undefined,
      clock: () => fake.now,
      anaf: { client: app, environment: 'test', fetch: http },
    });
    open.push(s);
    const { issue } = await salesCompany(s);

    const { url } = await s.invoke<{ url: string }>(s.owner, 'spv.connect.start');
    const state = new URL(url).searchParams.get('state')!;
    expect(
      (await s.refused(s.invoke(s.owner, 'spv.connect.finish', { code: 'c', state: `${state}x` })))
        ?.code,
    ).toBe('ANAF_STATE');
    expect(
      (await s.refused(s.invoke(s.reviewer, 'spv.connect.finish', { code: 'c', state })))?.code,
    ).toBeDefined();
    await s.invoke(s.owner, 'spv.connect.finish', { code: 'code-1', state });
    expect(await s.invoke(s.owner, 'spv.connection')).toMatchObject({
      connected: true,
      environment: 'test',
    });
    const [stored] = await s.engine.db.read((tx) => tx.select().from(anafConnections));
    expect(JSON.stringify(stored)).not.toContain('access-1');

    await s.invoke(s.owner, 'spv.submit', { documentId: (await issue()).documentId });
    expect(simulated.calls.at(-1)!.authorization).toBe('Bearer access-1');
    // Close to the access token's 90 days, the next call renews it with the refresh token.
    fake.advance(85 * 86_400_000);
    await s.invoke(s.owner, 'spv.submit', {
      documentId: (await issue({ issueDate: '2026-06-03' })).documentId,
    });
    expect(grants.map((grant) => grant.grant_type)).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(grants[1]!.refresh_token).toBe('refresh-1');
    expect(simulated.calls.at(-1)!.authorization).toBe('Bearer access-2');
  });
});
