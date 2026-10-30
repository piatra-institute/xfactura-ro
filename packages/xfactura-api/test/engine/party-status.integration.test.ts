import { afterAll, describe, expect, test } from 'bun:test';
import type { LocalDate } from 'xfactura-core/time';
import {
  ANAF_TAXPAYERS_URL,
  AnafTaxpayers,
  Pacer,
  parseTaxpayerAnswer,
  TaxpayerLookupFailed,
  type TaxpayerQuery,
} from '../../source/engine/adapters/anaf-taxpayers';
import type { ProposalView } from '../../source/engine/kernel/views';
import { FakeTaxpayers } from './fakes/anaf-taxpayers';
import { recordedAnswer, recordedQueries } from './fixtures/anaf-taxpayers';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const bytes = (text: string) => new TextEncoder().encode(text);
const queries = recordedQueries as TaxpayerQuery[];
const failure = (run: () => unknown) => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

/** ANAF's service as the documentation gives it, answering from the fake's registers. */
function anaf(fake: FakeTaxpayers, reply?: (call: number) => Response | Promise<Response> | null) {
  const calls: { url: string; method: string; type: string | null; body: unknown }[] = [];
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { cui: number; data: string }[];
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      type: new Headers(init?.headers).get('Content-Type'),
      body,
    });
    const scripted = await reply?.(calls.length);
    if (scripted) return scripted;
    return Response.json(
      fake.answer(body.map((item) => ({ cui: String(item.cui), date: item.data as LocalDate }))),
    );
  }) as typeof fetch;
  return { calls, http };
}
/** A pacer on a clock that only its waits move. */
function pacing() {
  let now = 0;
  const slept: number[] = [];
  const pacer = new Pacer(
    1000,
    () => now,
    async (ms) => {
      slept.push(ms);
      now += ms;
    },
  );
  return { pacer, slept };
}

describe('ANAF taxpayer service (v9)', () => {
  test('reads each CUI on its date from the documented answer, and the CUIs ANAF does not know', () => {
    expect(parseTaxpayerAnswer(bytes(recordedAnswer), queries)).toEqual([
      {
        cui: '18547290',
        date: '2026-10-01' as LocalDate,
        status: {
          name: 'FURNIZOR ACTIV SRL',
          vatPayer: true,
          cashVat: true,
          inactive: false,
          inactiveSince: null,
          reactivatedOn: null,
          splitVat: false,
          eInvoice: true,
          struckOffOn: null,
        },
      },
      {
        cui: '14399840',
        date: '2026-10-01' as LocalDate,
        status: {
          name: 'FURNIZOR INACTIV SRL',
          vatPayer: false,
          cashVat: false,
          inactive: true,
          inactiveSince: '2026-09-15' as LocalDate,
          reactivatedOn: null,
          splitVat: true,
          eInvoice: false,
          struckOffOn: null,
        },
      },
      { cui: '99999999', date: '2026-10-01' as LocalDate, status: null },
    ]);
  });

  test('anything but the documented answer, in full, is an error and never a taxpayer in good standing', () => {
    const answer = JSON.parse(recordedAnswer);
    const inactive = (change: (entry: Record<string, unknown>) => void) => {
      const copy = structuredClone(answer);
      change(copy.found[1]);
      return JSON.stringify(copy);
    };
    const variants: Record<string, [string, TaxpayerQuery[]]> = {
      'an HTML page': ['<html><body>The requested URL was rejected.</body></html>', queries],
      'an empty body': ['', queries],
      'the entries without their envelope': [JSON.stringify(answer.found), queries],
      'an error code': [JSON.stringify({ ...answer, cod: 404, message: 'NOT FOUND' }), queries],
      'a status written as text': [
        inactive(
          (entry) => ((entry.stare_inactiv as Record<string, unknown>).statusInactivi = 'true'),
        ),
        queries,
      ],
      'a register left out': [inactive((entry) => delete entry.stare_inactiv), queries],
      'a date in another format': [
        inactive(
          (entry) =>
            ((entry.stare_inactiv as Record<string, unknown>).dataInactivare = '15.09.2026'),
        ),
        queries,
      ],
      'an answer about a CUI not asked': [recordedAnswer, queries.slice(1)],
      'a CUI left unanswered': [
        recordedAnswer,
        [...queries, { cui: '11111110', date: '2026-10-01' as LocalDate }],
      ],
      'the date asked changed': [
        recordedAnswer,
        queries.map((query) => ({ ...query, date: '2026-10-02' as LocalDate })),
      ],
    };
    const accepted = Object.entries(variants)
      .filter(
        ([, [text, asked]]) =>
          !(failure(() => parseTaxpayerAnswer(bytes(text), asked)) instanceof TaxpayerLookupFailed),
      )
      .map(([name]) => name);
    expect(accepted).toEqual([]);
  });

  test('posts the documented request, at most 100 CUIs at a time and one request a second', async () => {
    const fake = new FakeTaxpayers();
    const asked = Array.from({ length: 250 }, (_, index) => {
      const cui = String(20_000_000 + index);
      fake.taxpayer(cui);
      return { cui, date: '2026-10-01' as LocalDate };
    });
    const { calls, http } = anaf(fake);
    const { pacer, slept } = pacing();
    const answers = await new AnafTaxpayers({ fetch: http, pacer }).lookup([...asked, asked[0]!]);
    expect(calls.map((call) => [call.method, call.url, call.type])).toEqual(
      Array(3).fill(['POST', ANAF_TAXPAYERS_URL, 'application/json']),
    );
    expect(calls.map((call) => (call.body as unknown[]).length)).toEqual([100, 100, 50]);
    expect((calls[0]!.body as unknown[])[0]).toEqual({ cui: 20000000, data: '2026-10-01' });
    expect(slept).toEqual([1000, 1000]);
    expect(answers.map((answer) => answer.results.length)).toEqual([100, 100, 50]);
    // Each answer keeps ANAF's bytes as they came.
    expect(JSON.parse(new TextDecoder().decode(answers[2]!.raw)).found).toHaveLength(50);
  });

  test('does not retry: a failed request ends the lookup with the answers before it', async () => {
    const fake = new FakeTaxpayers();
    const asked = Array.from({ length: 150 }, (_, index) => {
      const cui = String(30_000_000 + index);
      fake.taxpayer(cui);
      return { cui, date: '2026-10-01' as LocalDate };
    });
    const busy = anaf(fake, (call) => (call === 2 ? new Response('busy', { status: 503 }) : null));
    const error = await new AnafTaxpayers({ fetch: busy.http, pacer: pacing().pacer })
      .lookup(asked)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxpayerLookupFailed);
    expect((error as TaxpayerLookupFailed).message).toBe('ANAF a răspuns 503: busy');
    expect((error as TaxpayerLookupFailed).answered.map((item) => item.results.length)).toEqual([
      100,
    ]);
    expect(busy.calls).toHaveLength(2);
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(
      new AnafTaxpayers({ fetch: down, pacer: pacing().pacer }).lookup(asked.slice(0, 1)),
    ).rejects.toThrow(new TaxpayerLookupFailed('ANAF nu a răspuns: ECONNRESET'));
    // HTTP 200 with a page instead of the answer.
    const rejected = anaf(fake, () => new Response('<html>Request Rejected</html>'));
    await expect(
      new AnafTaxpayers({ fetch: rejected.http, pacer: pacing().pacer }).lookup(asked.slice(0, 1)),
    ).rejects.toBeInstanceOf(TaxpayerLookupFailed);
  });

  test('abandons a request that does not answer in time', async () => {
    const silent = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
      )) as typeof fetch;
    const error = await new AnafTaxpayers({ fetch: silent, pacer: pacing().pacer, timeout: 20 })
      .lookup([{ cui: '18547290', date: '2026-10-01' as LocalDate }])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxpayerLookupFailed);
    expect((error as Error).message).toStartWith('ANAF nu a răspuns:');
  });
});

type CheckView = {
  results: {
    partyId: string;
    date: string;
    outcome: string;
    status: { seq: number; inactive: boolean; evidenceId: string; [field: string]: unknown } | null;
    detail: string | null;
  }[];
};
type Finding = {
  code: string;
  severity: string;
  message: string;
  count?: number;
  items?: string[];
};

const today = Date.parse('2026-10-30T09:00:00Z');
/** The default counterparty of the invoice fixture. */
const supplier = '87654321';

/** A VAT payer whose partners ANAF answers about from `fake`. */
async function company(fake = new FakeTaxpayers()) {
  const s = await scenario({ taxpayers: fake, clock: () => today });
  open.push(s);
  const { id: evidenceId } = await s.evidence('certificat-tva.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId,
  });
  return { s, fake };
}
async function importInvoice(s: Scenario, input: XmlInput) {
  const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: `${input.number ?? 'INV-1'}.xml`,
    mediaType: 'application/xml',
    base64: Buffer.from(invoiceXml(input)).toString('base64'),
  });
  return s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', { evidenceId });
}
const check = (s: Scenario, input: unknown, key?: string) =>
  s.invoke<CheckView>(s.owner, 'parties.checkStatus', input, key);
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) =>
  proposal.issues.map((issue) => `${issue.code}/${issue.severity}`);

describe('checking partners at ANAF', () => {
  test('records the status of each supplier of the month on its tax point, with ANAF’s answer', async () => {
    const { s, fake } = await company();
    fake.taxpayer(supplier, { name: 'FURNIZOR SRL' }).inactivate(supplier, '2026-09-15');
    const first = await importInvoice(s, { number: 'F-1', date: '2026-10-01' });
    await importInvoice(s, { number: 'F-2', date: '2026-10-02', taxPointDate: '2026-09-30' });
    const checked = await check(s, { month: '2026-10' });
    expect(checked.results.map((item) => [item.date, item.outcome, item.status?.seq])).toEqual([
      ['2026-10-01', 'checked', 1],
      ['2026-09-30', 'checked', 2],
    ]);
    expect(checked.results[0]).toMatchObject({
      partyId: first.partyId,
      status: {
        name: 'FURNIZOR SRL',
        vatPayer: true,
        inactive: true,
        inactiveSince: '2026-09-15',
        reactivatedOn: null,
        eInvoice: true,
      },
    });
    // One request for both dates; its answer is kept as evidence.
    expect(fake.requests).toEqual([
      [
        { cui: supplier, date: '2026-10-01' as LocalDate },
        { cui: supplier, date: '2026-09-30' as LocalDate },
      ],
    ]);
    const kept = await s.invoke<{ mediaType: string; base64: string }>(s.owner, 'evidence.get', {
      id: checked.results[0]!.status!.evidenceId,
    });
    expect(kept.mediaType).toBe('application/json');
    expect(JSON.parse(Buffer.from(kept.base64, 'base64').toString()).found).toHaveLength(2);
  });

  test('only partners established in Romania, with a CUI, are asked about', async () => {
    const { s, fake } = await company();
    fake.taxpayer('18547290');
    const foreign = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'eu_taxable',
      country: 'DE',
      taxId: 'DE123456789',
      name: 'Lieferant GmbH',
    });
    const person = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Ion Popescu',
    });
    const unknown = await s.party('Necunoscut SRL', 'RO11111110');
    const known = await s.party('Cunoscut SRL', '18547290');
    const checked = await check(s, {
      partyIds: [foreign.id, person.id, unknown.id, known.id],
      date: '2026-10-01',
    });
    expect(checked.results.map((item) => item.outcome)).toEqual([
      'not_applicable',
      'not_applicable',
      'not_found',
      'checked',
    ]);
    expect(fake.requests).toEqual([
      [
        { cui: '11111110', date: '2026-10-01' as LocalDate },
        { cui: '18547290', date: '2026-10-01' as LocalDate },
      ],
    ]);
    expect((await s.refused(check(s, { partyIds: [known.id], date: '2026-10-31' })))?.code).toBe(
      'STATUS_DATE',
    );
    expect((await s.refused(check(s, { partyIds: [known.id] })))?.code).toBeDefined();
  });

  test('when ANAF does not answer nothing is recorded, and the same key is retried', async () => {
    const { s, fake } = await company();
    fake.taxpayer('18547290');
    const known = await s.party('Cunoscut SRL', '18547290');
    const input = { partyIds: [known.id], date: '2026-10-01' };
    fake.script = ['unavailable', 'rejected'];
    expect((await s.refused(check(s, input, 'status-key-1')))?.code).toBe('TAXPAYERS_UNAVAILABLE');
    // An answer without the documented envelope is no answer either.
    expect((await s.refused(check(s, input, 'status-key-1')))?.code).toBe('TAXPAYERS_UNAVAILABLE');
    expect((await check(s, input, 'status-key-1')).results[0]).toMatchObject({
      outcome: 'checked',
      status: { seq: 1, inactive: false },
    });
  });

  test('a request failing after others keeps their answers and reports the rest', async () => {
    const { s, fake } = await company();
    const ids: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const cui = String(40_000_000 + index);
      fake.taxpayer(cui);
      ids.push((await s.party(`Partener ${index}`, cui)).id);
    }
    fake.script = ['answer', 'unavailable'];
    const checked = await check(s, { partyIds: ids, date: '2026-10-01' });
    expect(checked.results.filter((item) => item.outcome === 'checked')).toHaveLength(100);
    expect(checked.results.at(-1)).toMatchObject({
      outcome: 'error',
      detail: 'ANAF nu a răspuns: The operation timed out.',
    });
  });

  test('is unavailable when the engine has no connection to ANAF', async () => {
    const s = await scenario();
    open.push(s);
    const party = await s.party('Cunoscut SRL', '18547290');
    expect((await s.refused(check(s, { partyIds: [party.id], date: '2026-10-01' })))?.code).toBe(
      'TAXPAYERS_UNAVAILABLE',
    );
  });
});

describe('purchases from an inactive supplier (Codul fiscal art. 11 alin. (7))', () => {
  test('deduct no VAT: deducting is blocked, recognizing without deduction posts', async () => {
    const { s, fake } = await company();
    fake.taxpayer(supplier).inactivate(supplier, '2026-09-15');
    const document = await importInvoice(s, { number: 'F-1' });
    await check(s, { month: '2026-10' });
    const blocked = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
    });
    expect([blocked.status, ...codes(blocked)]).toEqual(['blocked', 'SUPPLIER_INACTIVE/block']);
    expect(blocked.issues[0]).toMatchObject({
      path: 'deduction',
      details: {
        clause: 'ANAF/Cod-fiscal-consolidat:art.11(7)',
        date: '2026-10-01',
      },
    });
    expect(blocked.issues[0]!.message).toContain('art. 11 alin. (7) din Codul fiscal');
    expect(blocked.issues[0]!.message).toContain('executare silită');
    expect(blocked.issues[0]!.message).toContain('falimentului (Legea nr. 85/2014)');
    expect((await s.refused(s.approve(blocked)))?.code).toBe('BLOCKING_ISSUES');

    const revised = await s.revise('invoices.recognize', blocked, {
      documentId: document.id,
      account: '628',
      deduction: 'none',
    });
    expect(codes(revised)).toEqual([]);
    expect(lines(revised)).toEqual(['D 628 121.00', 'C 401 121.00']);
    expect(revised.effect?.taxEntries[0]).toMatchObject({ deductible: '0.00' });
    expect(revised.effect?.explanation.details).toMatchObject({
      supplierStatus: { date: '2026-10-01', inactive: true },
    });
    expect((await s.post(await s.approve(revised))).status).toBe('posted');

    // Split over accounts, every part goes without deduction.
    const mixed = await importInvoice(s, { number: 'F-2' });
    const partly = await s.propose('invoices.recognize', {
      documentId: mixed.id,
      allocations: [
        { account: '628', vat: 'S-21', amount: '60.00', deduction: 'none' },
        { account: '6022', vat: 'S-21', amount: '40.00', deduction: 'limited' },
      ],
    });
    expect(codes(partly)).toEqual(['SUPPLIER_INACTIVE/block']);
    expect(partly.issues[0]!.path).toBe('allocations');
  });

  test('an exception of the article deducts, once the reviewer acknowledges it', async () => {
    const { s, fake } = await company();
    fake.taxpayer(supplier).inactivate(supplier, '2026-09-15');
    const document = await importInvoice(s, { number: 'F-3' });
    await check(s, { partyIds: [document.partyId], date: '2026-10-01' });
    const proposal = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
      inactiveException: 'bankruptcy',
    });
    expect(codes(proposal)).toEqual(['SUPPLIER_INACTIVE_EXCEPTION/ack']);
    expect(proposal.issues[0]!.message).toContain('procedura falimentului');
    expect(lines(proposal)).toEqual(['D 628 100.00', 'D 4426 21.00', 'C 401 121.00']);
    expect((await s.refused(s.approve(proposal)))?.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
    await s.post(await s.approve(proposal, s.reviewer, ['SUPPLIER_INACTIVE_EXCEPTION']));

    // The exception belongs to a purchase from a supplier inactive on the invoice's date.
    const sale = await importInvoice(s, { number: 'V-1', direction: 'sale' });
    expect(
      codes(
        await s.propose('invoices.recognize', {
          documentId: sale.id,
          account: '704',
          inactiveException: 'forced_execution',
        }),
      ),
    ).toEqual(['INACTIVE_EXCEPTION/block']);
  });

  test('a supplier reactivated before the tax point, or never checked, deducts as usual', async () => {
    const { s, fake } = await company();
    fake.taxpayer(supplier).inactivate(supplier, '2026-06-01', '2026-09-01');
    const document = await importInvoice(s, { number: 'F-4' });
    await check(s, { month: '2026-10' });
    const proposal = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
    });
    expect(codes(proposal)).toEqual([]);
    expect(proposal.effect?.explanation.details).toMatchObject({
      supplierStatus: { inactive: false },
    });
    // Without a snapshot for the tax point the treatment does not refuse.
    const later = await importInvoice(s, { number: 'F-5', date: '2026-10-05' });
    expect(
      codes(await s.propose('invoices.recognize', { documentId: later.id, account: '628' })),
    ).toEqual([]);
  });
});

describe('the status read', () => {
  test('a snapshot recorded after the proposal makes it stale', async () => {
    const { s, fake } = await company();
    fake.taxpayer(supplier);
    const document = await importInvoice(s, { number: 'F-6' });
    const input = { documentId: document.id, account: '628' };
    // Proposed before any check, then the supplier turns out inactive on the tax point.
    const unchecked = await s.approve(await s.propose('invoices.recognize', input));
    fake.inactivate(supplier, '2026-09-15');
    await check(s, { month: '2026-10' });
    expect((await s.refused(s.post(unchecked)))?.code).toBe('STALE');
    const revised = await s.revise('invoices.recognize', unchecked, input);
    expect(codes(revised)).toEqual(['SUPPLIER_INACTIVE/block']);

    // A newer snapshot for the same date is a change too, even when it says the same.
    const other = await importInvoice(s, { number: 'F-7', date: '2026-10-07' });
    fake.taxpayer(supplier);
    await check(s, { partyIds: [other.partyId], date: '2026-10-07' });
    const approved = await s.approve(
      await s.propose('invoices.recognize', { documentId: other.id, account: '628' }),
    );
    // A snapshot for another date is not read.
    await check(s, { partyIds: [other.partyId], date: '2026-10-08' });
    await check(s, { partyIds: [other.partyId], date: '2026-10-07' });
    expect((await s.refused(s.post(approved)))?.code).toBe('STALE');
  });
});

describe('closing a month', () => {
  test('warns about purchases whose Romanian supplier was not checked on the invoice date', async () => {
    const { s, fake } = await company();
    fake.taxpayer(supplier);
    const document = await importInvoice(s, { number: 'F-8' });
    await importInvoice(s, { number: 'F-9', country: 'DE', counterparty: 'DE123456789' });
    const findings = async () =>
      ((await s.close('2026-10')).preview as { findings: Finding[] }).findings.filter(
        (finding) => finding.code === 'SUPPLIER_STATUS_UNCHECKED',
      );
    expect(await findings()).toEqual([
      {
        code: 'SUPPLIER_STATUS_UNCHECKED',
        severity: 'warn',
        message: expect.stringContaining('art. 11 alin. (7)'),
        count: 1,
        items: [document.id],
      },
    ]);
    // A status for another date does not count.
    await check(s, { partyIds: [document.partyId], date: '2026-10-02' });
    expect((await findings())[0]?.count).toBe(1);
    await check(s, { month: '2026-10' });
    expect(await findings()).toEqual([]);
  });
});
