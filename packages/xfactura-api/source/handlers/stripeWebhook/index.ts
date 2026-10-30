import stripe from '../../services/stripe';

import {
    fulfilUserCheckoutSession,
} from '../../logic/updateUser';

import {
    createStripeWebhookHandler,
} from './handler';



export {
    rawBody,
} from './handler';


export default createStripeWebhookHandler({
    webhooks: stripe.webhooks,
    secret: process.env.STRIPE_WEBHOOK_SECRET || '',
    fulfil: fulfilUserCheckoutSession,
});
