/**
 * Read-only reconciliation of legacy paid acts against Stripe Checkout.
 *
 * Lists:
 * - sessions credited in `users.payments` that Stripe reports unpaid (or cannot find);
 * - paid act sessions in Stripe that were never credited;
 * - sessions credited more than once.
 *
 * It only reads: `SELECT` on the legacy `users` table, and Stripe Checkout
 * Session list/retrieve. It writes nothing, credits nothing and refunds nothing.
 *
 * From the repository root, with the legacy deployment's values in the environment
 * (Bun loads `.env` from the working directory):
 *
 *     STRIPE_SECRET_KEY=... DATABASE_URL=... DATABASE_AUTH_TOKEN=... \
 *         bun packages/xfactura-api/scripts/legacy/reconcile-acts.ts [--since=YYYY-MM-DD] [--json]
 *
 * `--since` limits the Stripe listing (and so the "paid, never credited" check);
 * every credited session is still checked against Stripe. A restricted key with
 * read access to Checkout Sessions is enough. Exit code 1 means discrepancies.
 */
import { createClient } from '@libsql/client';
import Stripe from 'stripe';

import {
    isActPack,
    isPaidSession,
} from '../../source/logic/acts';



export interface CreditedSession {
    sessionID: string;
    productType: string;
    userID: string;
    email: string;
}

export interface StripeSessionFacts {
    id: string;
    status: Stripe.Checkout.Session.Status | null;
    payment_status: Stripe.Checkout.Session.PaymentStatus;
    userID: string | null;
    productType: string | null;
    created: number;
    amountTotal: number | null;
    currency: string | null;
}

export interface Reconciliation {
    creditedUnpaid: {
        credit: CreditedSession;
        /** `null` when Stripe has no such session (for example, the other mode's key). */
        session: StripeSessionFacts | null;
    }[];
    paidUncredited: StripeSessionFacts[];
    duplicateCredits: {
        sessionID: string;
        credits: CreditedSession[];
    }[];
}


export const sessionFacts = (
    session: Stripe.Checkout.Session,
): StripeSessionFacts => ({
    id: session.id,
    status: session.status,
    payment_status: session.payment_status,
    userID: session.metadata?.userID || null,
    productType: session.metadata?.productType || null,
    created: session.created,
    amountTotal: session.amount_total,
    currency: session.currency,
});


/** Pure comparison of what was credited with what Stripe reports. */
export const reconcile = (
    credits: CreditedSession[],
    sessions: ReadonlyMap<string, StripeSessionFacts>,
): Reconciliation => {
    const bySession = new Map<string, CreditedSession[]>();
    for (const credit of credits) {
        bySession.set(credit.sessionID, [...(bySession.get(credit.sessionID) ?? []), credit]);
    }

    const creditedUnpaid: Reconciliation['creditedUnpaid'] = [];
    const duplicateCredits: Reconciliation['duplicateCredits'] = [];
    for (const [sessionID, sessionCredits] of bySession) {
        const session = sessions.get(sessionID) ?? null;
        if (!session || !isPaidSession(session)) {
            for (const credit of sessionCredits) {
                creditedUnpaid.push({ credit, session });
            }
        }
        if (sessionCredits.length > 1) {
            duplicateCredits.push({ sessionID, credits: sessionCredits });
        }
    }

    const paidUncredited = [...sessions.values()].filter((session) =>
        !!session.userID
        && isActPack(session.productType)
        && isPaidSession(session)
        && !bySession.has(session.id),
    );

    return {
        creditedUnpaid,
        paidUncredited,
        duplicateCredits,
    };
}


const readCredits = async (
    database: ReturnType<typeof createClient>,
) => {
    const result = await database.execute('SELECT id, email, payments FROM users');

    const credits: CreditedSession[] = [];
    const unreadable: string[] = [];
    for (const row of result.rows) {
        const userID = String(row.id);
        const email = String(row.email);
        try {
            const payments: unknown = JSON.parse(String(row.payments || '[]'));
            if (!Array.isArray(payments)) {
                throw new Error('payments is not an array');
            }
            for (const payment of payments) {
                credits.push({
                    sessionID: String(payment?.sessionID),
                    productType: String(payment?.productType),
                    userID,
                    email,
                });
            }
        } catch {
            unreadable.push(userID);
        }
    }

    return {
        users: result.rows.length,
        credits,
        unreadable,
    };
}


const describeSession = (
    session: StripeSessionFacts,
) => {
    const amount = session.amountTotal === null
        ? 'amount unknown'
        : `${(session.amountTotal / 100).toFixed(2)} ${(session.currency ?? '').toUpperCase()}`;
    const created = new Date(session.created * 1000).toISOString().slice(0, 10);

    return `status=${session.status} payment=${session.payment_status} created=${created} ${amount}`;
}


const print = (
    reconciliation: Reconciliation,
    context: {
        mode: string;
        users: number;
        credits: number;
        sessions: number;
        since: string | null;
        unreadable: string[];
    },
) => {
    console.log(`Legacy acts reconciliation (Stripe ${context.mode} mode, read-only)`);
    console.log(`Users: ${context.users}. Credited sessions: ${context.credits}.`);
    console.log(`Stripe Checkout Sessions examined: ${context.sessions}${context.since ? ` (listing since ${context.since})` : ''}.`);
    if (context.unreadable.length > 0) {
        console.log(`Users whose payments could not be read: ${context.unreadable.join(', ')}`);
    }

    console.log(`\nCredited, but Stripe reports unpaid (${reconciliation.creditedUnpaid.length}):`);
    for (const { credit, session } of reconciliation.creditedUnpaid) {
        console.log(
            `  ${credit.sessionID}  user ${credit.userID} <${credit.email}>  pack ${credit.productType}  `
            + (session ? describeSession(session) : 'not found in Stripe'),
        );
    }

    console.log(`\nPaid, never credited (${reconciliation.paidUncredited.length}):`);
    for (const session of reconciliation.paidUncredited) {
        console.log(`  ${session.id}  user ${session.userID}  pack ${session.productType}  ${describeSession(session)}`);
    }

    console.log(`\nCredited more than once (${reconciliation.duplicateCredits.length}):`);
    for (const { sessionID, credits } of reconciliation.duplicateCredits) {
        console.log(`  ${sessionID}  ${credits.map((credit) => `user ${credit.userID} pack ${credit.productType}`).join('; ')}`);
    }
}


const main = async () => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const databaseURL = process.env.DATABASE_URL;
    if (!secretKey || !databaseURL) {
        console.error('Set STRIPE_SECRET_KEY and DATABASE_URL (and DATABASE_AUTH_TOKEN for Turso) for the legacy deployment.');
        process.exit(2);
    }

    const sinceArgument = process.argv.find((argument) => argument.startsWith('--since='));
    const since = sinceArgument ? sinceArgument.slice('--since='.length) : null;
    const sinceSeconds = since ? Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) : null;
    if (since && !Number.isFinite(sinceSeconds)) {
        console.error('--since must be a date, YYYY-MM-DD.');
        process.exit(2);
    }
    const asJSON = process.argv.includes('--json');
    const mode = /^(sk|rk)_live_/.test(secretKey) ? 'live' : 'test';

    const stripe = new Stripe(secretKey);
    const database = createClient({
        url: databaseURL,
        authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    });

    try {
        const { users, credits, unreadable } = await readCredits(database);

        const sessions = new Map<string, StripeSessionFacts>();
        const listing = stripe.checkout.sessions.list({
            limit: 100,
            ...(sinceSeconds ? { created: { gte: sinceSeconds } } : {}),
        });
        for await (const session of listing) {
            sessions.set(session.id, sessionFacts(session));
        }

        // Credited sessions outside the listing are looked up one by one.
        for (const credit of credits) {
            if (sessions.has(credit.sessionID)) {
                continue;
            }
            try {
                const session = await stripe.checkout.sessions.retrieve(credit.sessionID);
                sessions.set(session.id, sessionFacts(session));
            } catch (error) {
                if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) {
                    continue;
                }
                throw error;
            }
        }

        const reconciliation = reconcile(credits, sessions);
        if (asJSON) {
            console.log(JSON.stringify({ mode, users, unreadable, ...reconciliation }, null, 2));
        } else {
            print(reconciliation, {
                mode,
                users,
                credits: credits.length,
                sessions: sessions.size,
                since,
                unreadable,
            });
        }

        const discrepancies = reconciliation.creditedUnpaid.length
            + reconciliation.paidUncredited.length
            + reconciliation.duplicateCredits.length
            + unreadable.length;
        process.exitCode = discrepancies > 0 ? 1 : 0;
    } finally {
        database.close();
    }
}


if (import.meta.main) {
    await main();
}
