import type {
    Request,
    Response,
} from 'express';

import stripe from '../../services/stripe';

import {
    getTokensUser,
    getDatabaseUser,
} from '../../logic/getUser';

import {
    fulfilUserCheckoutSession,
} from '../../logic/updateUser';

import {
    isPendingSession,
} from '../../logic/acts';

import {
    logger,
} from '../../utilities';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const tokensUser = await getTokensUser(request, response);
        if (!tokensUser) {
            logger('warn', 'User not found');

            response.status(200).json({
                status: false,
            });
            return;
        }

        const databaseUser = await getDatabaseUser(tokensUser);
        if (!databaseUser) {
            logger('warn', 'User not found in database');

            response.status(200).json({
                status: false,
            });
            return;
        }

        switch (request.method) {
            case 'POST':
                try {
                    const {
                        productType,
                    } = request.body;

                    if (!productType) {
                        throw new Error('Invalid product type');
                    }

                    let priceID = '';

                    switch (productType) {
                        case '300':
                            priceID = process.env.STRIPE_PRICE_300 || '';
                            break;
                        case '1000':
                            priceID = process.env.STRIPE_PRICE_1000 || '';
                            break;
                        case '5000':
                            priceID = process.env.STRIPE_PRICE_5000 || '';
                            break;
                        default:
                            throw new Error('Invalid plan type');
                    }

                    const session = await stripe.checkout.sessions.create({
                        ui_mode: 'embedded',
                        line_items: [
                            {
                                price: priceID,
                                quantity: 1,
                            },
                        ],
                        mode: 'payment',
                        return_url: `${request.headers.origin}/plata?sid={CHECKOUT_SESSION_ID}`,
                        metadata: {
                            userID: databaseUser.id,
                            productType,
                        },
                    });

                    response.send({
                        status: true,
                        data: {
                            clientSecret: session.client_secret,
                        },
                    });
                } catch (error: any) {
                    logger('error', error);

                    response.status(error.statusCode || 500).json(error.message);
                }
                break;
            case 'GET':
                try {
                    const sessionID = request.query.sid;
                    if (typeof sessionID !== 'string' || !sessionID.startsWith('cs_')) {
                        response.status(400).json({
                            status: false,
                        });
                        return;
                    }

                    const session = await stripe.checkout.sessions.retrieve(sessionID);

                    if (session.metadata?.userID !== databaseUser.id) {
                        response.send({
                            status: false,
                        });
                        return;
                    }

                    // Fallback for the webhook: both go through the same
                    // idempotent credit, which refuses unpaid sessions.
                    const fulfilment = await fulfilUserCheckoutSession(session);
                    if (fulfilment.outcome === 'credited') {
                        logger('info', 'Checkout session credited', session.id, fulfilment.acts);
                    }

                    const credited = fulfilment.outcome === 'credited'
                        || fulfilment.outcome === 'already-credited';

                    response.send({
                        status: credited,
                        data: {
                            customerEmail: session.customer_details?.email ?? '',
                            pending: isPendingSession(session),
                        },
                    });
                } catch (error: any) {
                    logger('error', error);

                    response.status(error.statusCode || 500).json(error.message);
                }
                break;
            default:
                logger('warn', 'Method Not Allowed');
                response.setHeader('Allow', request.method || '');
                response.status(405).end('Method Not Allowed');
        }
    } catch (error) {
        logger('error', error);

        response.status(400).json({
            status: false,
        });
    }
}
