// Legacy paid acts: crediting Checkout Sessions, the Stripe webhook and charging.
// Runs on a temporary local libSQL file with two connections, so concurrent
// calls interleave at every await as concurrent requests do in the API.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import express from 'express';
import Stripe from 'stripe';
import {
  chargeIntelligentAct,
  fulfilCheckoutSession,
  isPaidSession,
  type CheckoutSessionView,
  type FulfilmentOutcome,
} from '../../source/logic/acts';
import { createStripeWebhookHandler, rawBody } from '../../source/handlers/stripeWebhook/handler';
import { parseUserPayments } from '../../source/utilities/database';
import { reconcile, type CreditedSession, type StripeSessionFacts } from '../../scripts/legacy/reconcile-acts';

// Mirrors source/database/schema/users.ts.
const USERS_TABLE = `CREATE TABLE users (
  id text PRIMARY KEY NOT NULL,
  created_at text NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  picture text NOT NULL,
  payments text NOT NULL,
  intelligent_acts integer NOT NULL,
  free_intelligent_acts integer NOT NULL
)`;

const USER = 'user-1';

let directory: string;
let first: Client;
let second: Client;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-legacy-acts-'));
  const url = `file:${join(directory, 'legacy.db')}`;
  first = createClient({ url });
  second = createClient({ url });
  await first.execute(USERS_TABLE);
});

afterAll(async () => {
  first.close();
  second.close();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await first.execute('DELETE FROM users');
  await addUser(USER);
});

async function addUser(id: string, acts = 0, freeActs = 0) {
  await first.execute({
    sql: `INSERT INTO users VALUES (?, '2024-01-01T00:00:00.000Z', ?, 'Test', '', '[]', ?, ?)`,
    args: [id, `${id}@example.com`, acts, freeActs],
  });
}

async function account(id = USER) {
  const result = await first.execute({
    sql: 'SELECT payments, intelligent_acts, free_intelligent_acts FROM users WHERE id = ?',
    args: [id],
  });
  const row = result.rows[0];
  return {
    payments: parseUserPayments(row),
    acts: Number(row.intelligent_acts),
    freeActs: Number(row.free_intelligent_acts),
  };
}

function session(overrides: Partial<CheckoutSessionView> = {}): CheckoutSessionView {
  return {
    id: 'cs_test_1',
    status: 'complete',
    payment_status: 'paid',
    metadata: { userID: USER, productType: '300' },
    ...overrides,
  };
}

/** Alternates the two connections, as separate requests would. */
const connection = (index: number) => (index % 2 === 0 ? first : second);

describe('crediting a Checkout Session', () => {
  test('only a completed and paid session counts as paid', () => {
    expect(isPaidSession({ status: 'open', payment_status: 'unpaid' })).toBe(false);
    expect(isPaidSession({ status: 'complete', payment_status: 'unpaid' })).toBe(false);
    expect(isPaidSession({ status: 'expired', payment_status: 'unpaid' })).toBe(false);
    expect(isPaidSession({ status: 'complete', payment_status: 'no_payment_required' })).toBe(false);
    expect(isPaidSession({ status: 'complete', payment_status: 'paid' })).toBe(true);
  });

  test('an open session does not credit', async () => {
    const outcome = await fulfilCheckoutSession(first, session({ status: 'open', payment_status: 'unpaid' }));

    expect(outcome).toEqual({ outcome: 'not-paid', pending: false });
    expect(await account()).toEqual({ payments: [], acts: 0, freeActs: 0 });
  });

  test('a completed session still awaiting a delayed payment does not credit', async () => {
    const outcome = await fulfilCheckoutSession(first, session({ payment_status: 'unpaid' }));

    expect(outcome).toEqual({ outcome: 'not-paid', pending: true });
    expect((await account()).acts).toBe(0);
  });

  test('an expired session does not credit', async () => {
    await fulfilCheckoutSession(first, session({ status: 'expired', payment_status: 'unpaid' }));

    expect((await account()).acts).toBe(0);
  });

  test('a paid session credits its pack once and records the session', async () => {
    const credited = await fulfilCheckoutSession(first, session({ metadata: { userID: USER, productType: '1000' } }));
    const again = await fulfilCheckoutSession(second, session({ metadata: { userID: USER, productType: '1000' } }));

    expect(credited).toEqual({ outcome: 'credited', acts: 1000, balance: 1000 });
    expect(again).toEqual({ outcome: 'already-credited' });
    expect(await account()).toEqual({
      payments: [{ productType: '1000', sessionID: 'cs_test_1' }],
      acts: 1000,
      freeActs: 0,
    });
  });

  test('sessions that are not act purchases credit nothing', async () => {
    const notActPurchases: CheckoutSessionView['metadata'][] = [
      null,
      {},
      { userID: USER },
      { userID: USER, productType: '999' },
      { userID: USER, productType: 'constructor' },
    ];
    for (const metadata of notActPurchases) {
      expect(await fulfilCheckoutSession(first, session({ metadata }))).toEqual({ outcome: 'not-an-act-purchase' });
    }
    expect((await account()).acts).toBe(0);
  });

  test('a paid session for an unknown user credits nobody', async () => {
    const outcome = await fulfilCheckoutSession(first, session({ metadata: { userID: 'someone-else', productType: '300' } }));

    expect(outcome).toEqual({ outcome: 'unknown-user' });
    expect((await account()).acts).toBe(0);
  });
});

describe('crediting under concurrency', () => {
  test('two concurrent credits of one session credit once', async () => {
    const outcomes = await Promise.all([
      fulfilCheckoutSession(first, session()),
      fulfilCheckoutSession(second, session()),
    ]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['already-credited', 'credited']);
    expect(await account()).toEqual({
      payments: [{ productType: '300', sessionID: 'cs_test_1' }],
      acts: 300,
      freeActs: 0,
    });
  });

  test('many concurrent deliveries of one session credit once', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) => fulfilCheckoutSession(connection(index), session())),
    );

    expect(outcomes.filter((outcome) => outcome.outcome === 'credited')).toHaveLength(1);
    expect((await account()).acts).toBe(300);
    expect((await account()).payments).toHaveLength(1);
  });

  test('concurrent credits of different sessions and charges do not overwrite each other', async () => {
    await first.execute({ sql: 'UPDATE users SET intelligent_acts = 10 WHERE id = ?', args: [USER] });

    await Promise.all([
      fulfilCheckoutSession(first, session({ id: 'cs_test_a', metadata: { userID: USER, productType: '1000' } })),
      ...Array.from({ length: 5 }, (_, index) => chargeIntelligentAct(connection(index), USER)),
      fulfilCheckoutSession(second, session({ id: 'cs_test_b', metadata: { userID: USER, productType: '300' } })),
    ]);

    const { acts, payments } = await account();
    expect(acts).toBe(10 + 1000 + 300 - 5);
    expect(payments.map((payment) => payment.sessionID).sort()).toEqual(['cs_test_a', 'cs_test_b']);
  });
});

describe('charging an act', () => {
  test('spends free acts first, then paid acts, and refuses at zero', async () => {
    await first.execute({ sql: 'UPDATE users SET intelligent_acts = 1, free_intelligent_acts = 1 WHERE id = ?', args: [USER] });

    expect(await chargeIntelligentAct(first, USER)).toBe(true);
    expect(await account()).toMatchObject({ acts: 1, freeActs: 0 });
    expect(await chargeIntelligentAct(first, USER)).toBe(true);
    expect(await account()).toMatchObject({ acts: 0, freeActs: 0 });
    expect(await chargeIntelligentAct(first, USER)).toBe(false);
    expect(await chargeIntelligentAct(first, 'someone-else')).toBe(false);
    expect(await account()).toMatchObject({ acts: 0, freeActs: 0 });
  });

  test('never goes negative or spends an act twice under concurrency', async () => {
    await first.execute({ sql: 'UPDATE users SET intelligent_acts = 3, free_intelligent_acts = 2 WHERE id = ?', args: [USER] });

    const charged = await Promise.all(
      Array.from({ length: 30 }, (_, index) => chargeIntelligentAct(connection(index), USER)),
    );

    expect(charged.filter(Boolean)).toHaveLength(5);
    expect(await account()).toMatchObject({ acts: 0, freeActs: 0 });
  });

  test('the same schedule reproduces the race in the previous read-then-write charge', async () => {
    await first.execute({ sql: 'UPDATE users SET intelligent_acts = 1 WHERE id = ?', args: [USER] });
    // The charge as it was before: read the user, then write the balance read minus one.
    const previousCharge = async (database: Client) => {
      const read = await database.execute({ sql: 'SELECT intelligent_acts FROM users WHERE id = ?', args: [USER] });
      const acts = Number(read.rows[0].intelligent_acts);
      if (acts < 1) return false;
      await database.execute({ sql: 'UPDATE users SET intelligent_acts = ? WHERE id = ?', args: [acts - 1, USER] });
      return true;
    };

    const charged = await Promise.all([previousCharge(first), previousCharge(second)]);

    // Two extractions for one act: the harness does interleave.
    expect(charged).toEqual([true, true]);
    expect((await account()).acts).toBe(0);
  });
});

describe('Stripe webhook', () => {
  const secret = 'whsec_test_signing_secret';
  let server: Server;
  let url: string;
  let fulfil: (session: Stripe.Checkout.Session) => Promise<FulfilmentOutcome>;

  let quiet: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    // The handler logs every delivery; keep the test output to results.
    quiet = (['info', 'warn', 'error'] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
    const app = express();
    // The same order as source/index.ts: the raw-body webhook before the JSON parser.
    app.post(
      '/stripe-webhook',
      rawBody,
      createStripeWebhookHandler({
        webhooks: Stripe.webhooks,
        secret,
        fulfil: (session) => fulfil(session),
      }),
    );
    app.use(express.json());
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stripe-webhook`;
  });

  afterAll(() => {
    server.close();
    for (const spy of quiet) spy.mockRestore();
  });

  beforeEach(() => {
    fulfil = (session) => fulfilCheckoutSession(first, session);
  });

  let eventCount = 0;
  function event(type: string, object: CheckoutSessionView) {
    eventCount += 1;
    return JSON.stringify({
      id: `evt_test_${eventCount}`,
      object: 'event',
      api_version: '2023-10-16',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      data: { object: { object: 'checkout.session', ...object } },
    });
  }

  function deliver(payload: string, signature: string | null) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(signature === null ? {} : { 'stripe-signature': signature }),
      },
      body: payload,
    });
  }

  const sign = (payload: string, signingSecret = secret) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret });

  test('a bad signature is refused and credits nothing', async () => {
    const payload = event('checkout.session.completed', session());

    const response = await deliver(payload, sign(payload, 'whsec_someone_else'));

    expect(response.status).toBe(400);
    expect((await account()).acts).toBe(0);
  });

  test('a missing or malformed signature is refused', async () => {
    const payload = event('checkout.session.completed', session());

    expect((await deliver(payload, null)).status).toBe(400);
    expect((await deliver(payload, 'not-a-signature')).status).toBe(400);
    expect((await account()).acts).toBe(0);
  });

  test('a body changed after signing is refused', async () => {
    const payload = event('checkout.session.completed', session());
    const signature = sign(payload);
    const tampered = payload.replace('"productType":"300"', '"productType":"5000"');
    expect(tampered).not.toBe(payload);

    expect((await deliver(tampered, signature)).status).toBe(400);
    expect((await account()).acts).toBe(0);
  });

  test('a signed completed event for an open session credits nothing', async () => {
    const payload = event('checkout.session.completed', session({ status: 'open', payment_status: 'unpaid' }));

    expect((await deliver(payload, sign(payload))).status).toBe(200);
    expect((await account()).acts).toBe(0);
  });

  test('a paid session credits once across webhook retries and the return page', async () => {
    const payload = event('checkout.session.completed', session());
    const signature = sign(payload);

    const [webhook, retry, returnPage] = await Promise.all([
      deliver(payload, signature),
      deliver(payload, signature),
      fulfilCheckoutSession(second, session()),
    ]);

    expect([webhook.status, retry.status]).toEqual([200, 200]);
    expect(['credited', 'already-credited']).toContain(returnPage.outcome);
    expect(await account()).toEqual({
      payments: [{ productType: '300', sessionID: 'cs_test_1' }],
      acts: 300,
      freeActs: 0,
    });
  });

  test('a delayed payment credits on async_payment_succeeded, not on completion', async () => {
    const completed = event('checkout.session.completed', session({ payment_status: 'unpaid' }));
    expect((await deliver(completed, sign(completed))).status).toBe(200);
    expect((await account()).acts).toBe(0);

    const succeeded = event('checkout.session.async_payment_succeeded', session());
    expect((await deliver(succeeded, sign(succeeded))).status).toBe(200);
    expect((await account()).acts).toBe(300);
  });

  test('other events are acknowledged without crediting', async () => {
    const payload = event('checkout.session.async_payment_failed', session());

    expect((await deliver(payload, sign(payload))).status).toBe(200);
    expect((await account()).acts).toBe(0);
  });

  test('a failed credit answers 500 so Stripe retries', async () => {
    fulfil = () => Promise.reject(new Error('database unavailable'));
    const payload = event('checkout.session.completed', session());

    expect((await deliver(payload, sign(payload))).status).toBe(500);
  });
});

describe('reconciliation', () => {
  const credit = (sessionID: string, userID = USER): CreditedSession => ({
    sessionID,
    productType: '300',
    userID,
    email: `${userID}@example.com`,
  });
  const facts = (id: string, overrides: Partial<StripeSessionFacts> = {}): StripeSessionFacts => ({
    id,
    status: 'complete',
    payment_status: 'paid',
    userID: USER,
    productType: '300',
    created: 1_700_000_000,
    amountTotal: 4900,
    currency: 'ron',
    ...overrides,
  });

  test('lists credited sessions Stripe reports unpaid, paid sessions never credited and double credits', () => {
    const sessions = new Map(
      [
        facts('cs_paid_credited'),
        facts('cs_open_credited', { status: 'open', payment_status: 'unpaid' }),
        facts('cs_paid_uncredited'),
        facts('cs_expired', { status: 'expired', payment_status: 'unpaid' }),
        facts('cs_other_product', { userID: null, productType: null }),
        facts('cs_twice'),
      ].map((session) => [session.id, session]),
    );

    const result = reconcile(
      [
        credit('cs_paid_credited'),
        credit('cs_open_credited'),
        credit('cs_missing'),
        credit('cs_twice'),
        credit('cs_twice', 'user-2'),
      ],
      sessions,
    );

    expect(result.creditedUnpaid.map(({ credit, session }) => [credit.sessionID, session?.status ?? null])).toEqual([
      ['cs_open_credited', 'open'],
      ['cs_missing', null],
    ]);
    expect(result.paidUncredited.map((session) => session.id)).toEqual(['cs_paid_uncredited']);
    expect(result.duplicateCredits.map(({ sessionID, credits }) => [sessionID, credits.length])).toEqual([['cs_twice', 2]]);
  });
});
