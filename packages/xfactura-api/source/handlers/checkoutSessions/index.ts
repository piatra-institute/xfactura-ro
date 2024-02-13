import type {
    Request,
    Response,
} from 'express';

import Stripe from 'stripe';

import {
    getTokensUser,
    getDatabaseUser,
} from '../../logic/getUser';

import {
    updateUserPayments,
} from '../../logic/updateUser';

import {
    logger,
} from '../../utilities';



const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');



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

                    await updateUserPayments(
                        databaseUser,
                        request.body.productType,
                        session.id,
                    );

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
