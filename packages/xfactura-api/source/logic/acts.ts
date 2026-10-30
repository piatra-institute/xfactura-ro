import type {
    Client,
} from '@libsql/client';

import type Stripe from 'stripe';



/** Acts credited per pack. The Checkout Session's `productType` metadata names the pack. */
export const ACT_PACKS = {
    '300': 300,
    '1000': 1000,
    '5000': 5000,
} as const;

export type ActPack = keyof typeof ACT_PACKS;

export const isActPack = (
    value: unknown,
): value is ActPack => typeof value === 'string' && Object.hasOwn(ACT_PACKS, value);


/** The legacy `users` table, through the libSQL client (`database.$client`). */
export type ActsDatabase = Pick<Client, 'execute'>;

export type CheckoutSessionView = Pick<
    Stripe.Checkout.Session,
    'id' | 'status' | 'payment_status' | 'metadata'
>;


/**
 * Only a completed session whose payment has cleared credits acts.
 * `open` means the customer has not paid. `complete` with `unpaid` is a delayed
 * payment method still processing; Stripe later sends
 * `checkout.session.async_payment_succeeded` with `paid`.
 */
export const isPaidSession = (
    session: Pick<CheckoutSessionView, 'status' | 'payment_status'>,
) => session.status === 'complete' && session.payment_status === 'paid';

export const isPendingSession = (
    session: Pick<CheckoutSessionView, 'status' | 'payment_status'>,
) => session.status === 'complete' && session.payment_status === 'unpaid';


// One statement, so SQLite applies the "not yet credited" check, the increment
// and the payment record atomically: concurrent return-page loads, retries and
// webhook deliveries cannot credit a session twice or overwrite each other.
// The session id recorded in `users.payments` is the idempotency key.
const CREDIT_SESSION = `
UPDATE users
SET intelligent_acts = intelligent_acts + :acts,
    payments = json_insert(
        COALESCE(NULLIF(payments, ''), '[]'),
        '$[#]',
        json_object('productType', :productType, 'sessionID', :sessionID)
    )
WHERE id = :userID
    AND NOT EXISTS (
        SELECT 1
        FROM json_each(COALESCE(NULLIF(users.payments, ''), '[]')) AS payment
        WHERE json_extract(payment.value, '$.sessionID') = :sessionID
    )
RETURNING intelligent_acts AS intelligentActs`;

// Free acts are spent first. Both CASE expressions read the row as it was
// before the update, and the WHERE clause refuses the update when nothing is
// left, so concurrent charges cannot spend one act twice or go below zero.
const CHARGE_ACT = `
UPDATE users
SET free_intelligent_acts = CASE
        WHEN free_intelligent_acts > 0 THEN free_intelligent_acts - 1
        ELSE free_intelligent_acts
    END,
    intelligent_acts = CASE
        WHEN free_intelligent_acts > 0 THEN intelligent_acts
        ELSE intelligent_acts - 1
    END
WHERE id = :userID
    AND (free_intelligent_acts > 0 OR intelligent_acts > 0)
RETURNING id`;


export type CreditOutcome =
    | { outcome: 'credited'; acts: number; balance: number }
    | { outcome: 'already-credited' }
    | { outcome: 'unknown-user' };

export type FulfilmentOutcome =
    | CreditOutcome
    | { outcome: 'not-paid'; pending: boolean }
    | { outcome: 'not-an-act-purchase' };


export const creditSessionOnce = async (
    database: ActsDatabase,
    credit: {
        userID: string;
        productType: ActPack;
        sessionID: string;
    },
): Promise<CreditOutcome> => {
    const acts = ACT_PACKS[credit.productType];

    const result = await database.execute({
        sql: CREDIT_SESSION,
        args: {
            acts,
            productType: credit.productType,
            sessionID: credit.sessionID,
            userID: credit.userID,
        },
    });
    const row = result.rows[0];
    if (row) {
        return {
            outcome: 'credited',
            acts,
            balance: Number(row.intelligentActs),
        };
    }

    const user = await database.execute({
        sql: 'SELECT 1 FROM users WHERE id = ?',
        args: [credit.userID],
    });

    return user.rows.length > 0
        ? { outcome: 'already-credited' }
        : { outcome: 'unknown-user' };
}


/**
 * The one path that turns a Checkout Session into acts, shared by the return
 * page and the webhook. Safe to call any number of times, concurrently.
 */
export const fulfilCheckoutSession = async (
    database: ActsDatabase,
    session: CheckoutSessionView,
): Promise<FulfilmentOutcome> => {
    const userID = session.metadata?.userID;
    const productType = session.metadata?.productType;
    if (!userID || !isActPack(productType)) {
        return { outcome: 'not-an-act-purchase' };
    }

    if (!isPaidSession(session)) {
        return {
            outcome: 'not-paid',
            pending: isPendingSession(session),
        };
    }

    return creditSessionOnce(database, {
        userID,
        productType,
        sessionID: session.id,
    });
}


/** Spends one act (free first). `false` when the user has none left. */
export const chargeIntelligentAct = async (
    database: ActsDatabase,
    userID: string,
) => {
    const result = await database.execute({
        sql: CHARGE_ACT,
        args: { userID },
    });

    return result.rows.length > 0;
}
