import express from 'express';
import type {
    Request,
    Response,
} from 'express';

import type Stripe from 'stripe';

import type {
    FulfilmentOutcome,
} from '../../logic/acts';

import {
    logger,
} from '../../utilities';



/**
 * Stripe signs the exact bytes it sends, so the webhook route reads the raw
 * body and must be registered before `express.json()`.
 */
export const rawBody = express.raw({
    type: '*/*',
    limit: '512kb',
});


export interface StripeWebhookOptions {
    webhooks: Pick<Stripe.Webhooks, 'constructEvent'>;
    /** The endpoint's signing secret (`whsec_...`). */
    secret: string;
    fulfil: (session: Stripe.Checkout.Session) => Promise<FulfilmentOutcome>;
}


export const createStripeWebhookHandler = ({
    webhooks,
    secret,
    fulfil,
}: StripeWebhookOptions) => async (
    request: Request,
    response: Response,
) => {
    const signature = request.headers['stripe-signature'];
    if (!secret || typeof signature !== 'string' || !Buffer.isBuffer(request.body)) {
        logger('warn', 'Stripe webhook refused: missing signature or body');

        response.status(400).json({
            received: false,
        });
        return;
    }

    let event: Stripe.Event;
    try {
        event = webhooks.constructEvent(request.body, signature, secret);
    } catch {
        logger('warn', 'Stripe webhook refused: invalid signature');

        response.status(400).json({
            received: false,
        });
        return;
    }

    if (
        event.type !== 'checkout.session.completed'
        && event.type !== 'checkout.session.async_payment_succeeded'
    ) {
        response.json({
            received: true,
        });
        return;
    }

    const session = event.data.object;

    try {
        const fulfilment = await fulfil(session);

        // A paid session for a user that no longer exists cannot be credited
        // by retrying; the reconciliation script lists it.
        logger(
            fulfilment.outcome === 'unknown-user' ? 'error' : 'info',
            'Stripe webhook',
            event.type,
            event.id,
            session.id,
            fulfilment.outcome,
        );

        response.json({
            received: true,
        });
    } catch (error) {
        logger('error', 'Stripe webhook fulfilment failed', event.id, session.id, error);

        // Stripe retries non-2xx deliveries; the credit is idempotent.
        response.status(500).json({
            received: false,
        });
    }
}
