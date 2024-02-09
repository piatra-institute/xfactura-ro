import type {
    Request,
    Response,
} from 'express';

import {
    eq,
} from 'drizzle-orm';

import Stripe from 'stripe';

import database from '../../database';
import {
    users,
} from '../../database/schema/users';

import getUser from '../../logic/getUser';

import {
    logger,
} from '../../utilities';



const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const intelligentActsMap = {
    '300': 300,
    '1000': 1000,
    '5000': 5000,
} as const;


export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const user = await getUser(request);
        if (!user) {
            logger('warn', 'User not found');

            response.status(400).json({
                status: false,
            });
            return;
        }

        const databaseUser = await database.query.users.findFirst({
            where: eq(users.email, user.email),
        });
        if (!databaseUser) {
            logger('warn', 'User not found in database');

            response.status(400).json({
                status: false,
            });
            return;
        }

        switch (request.method) {
            case 'POST':
                try {
                    let priceID = '';

                    switch (request.body.productType) {
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
                    });

                    const intelligentActs = databaseUser.intelligentActs
                        + intelligentActsMap[request.body.productType as keyof typeof intelligentActsMap];

                    await database.update(users).set({
                        intelligentActs,
                        payments: JSON.stringify([
                            ...JSON.parse(databaseUser.payments || '[]'),
                            {
                                amount: request.body.productType,
                                sessionID: session.id,
                            },
                        ]),
                    }).where(
                        eq(users.email, user.email),
                    );

                    response.send({
                        status: true,
                        data: {
                            clientSecret: session.client_secret,
                        },
                    });
                } catch (err: any) {
                    response.status(err.statusCode || 500).json(err.message);
                }
                break;
            case 'GET':
                try {
                    const session = await stripe.checkout.sessions.retrieve(
                        (request as any).query.sid,
                    );

                    response.send({
                        status: session.status,
                        data: {
                            customerEmail: (session as any).customer_details.email,
                        },
                    });
                } catch (error: any) {
                    logger('error', error);

                    response.status(error.statusCode || 500).json(error.message);
                }
                break;
            default:
                response.setHeader('Allow', request.method || '');
                response.status(405).end('Method Not Allowed');
        }
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
