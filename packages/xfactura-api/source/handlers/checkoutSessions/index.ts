import type {
    Request,
    Response,
} from 'express';

import Stripe from 'stripe';

import getUser from '../../logic/getUser';

import {
    logger,
} from '../../utilities';



const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');


export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        switch (request.method) {
            case 'POST':
                const user = await getUser(request);
                if (!user) {
                    logger('warn', 'User not found');

                    response.status(200).json({
                        status: false,
                    });
                    return;
                }

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

                    response.send({
                        status: true,
                        clientSecret: session.client_secret,
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
                        customer_email: (session as any).customer_details.email,
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
