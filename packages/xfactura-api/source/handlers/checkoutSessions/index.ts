import type {
    Request,
    Response,
} from 'express';

import Stripe from 'stripe';



const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');


export default async function handler(
    req: Request,
    res: Response,
) {
    switch (req.method) {
        case 'POST':
            try {
                let priceID = '';
                switch (req.body.productType) {
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
                    return_url: `${req.headers.origin}/return?session_id={CHECKOUT_SESSION_ID}`,
                });

                res.send({ clientSecret: session.client_secret });
            } catch (err: any) {
                res.status(err.statusCode || 500).json(err.message);
            }
            break;
        case 'GET':
            try {
                const session = await stripe.checkout.sessions.retrieve((req as any).query.session_id);

                res.send({
                    status: session.status,
                    customer_email: (session as any).customer_details.email,
                });
            } catch (err: any) {
                res.status(err.statusCode || 500).json(err.message);
            }
            break;
        default:
            res.setHeader('Allow', req.method || '');
            res.status(405).end('Method Not Allowed');
    }
}
