import database from '../database';

import {
    chargeIntelligentAct,
    fulfilCheckoutSession,
    type CheckoutSessionView,
} from './acts';



/** Credits a paid Checkout Session's acts exactly once. See `logic/acts.ts`. */
export const fulfilUserCheckoutSession = (
    session: CheckoutSessionView,
) => fulfilCheckoutSession(database.$client, session);


/** Atomically spends one act, free acts first. `false` when none are left. */
export const decreaseIntelligentAct = (
    databaseUser: { id: string },
) => chargeIntelligentAct(database.$client, databaseUser.id);
