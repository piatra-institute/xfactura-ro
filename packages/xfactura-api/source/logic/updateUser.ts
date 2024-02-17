import {
    eq,
} from 'drizzle-orm';

import database from '../database';
import {
    users,
} from '../database/schema/users';

import {
    UserPayment,
} from '../data';

import {
    parseUserPayments,
} from '../utilities/database';



const intelligentActsMap = {
    '300': 300,
    '1000': 1000,
    '5000': 5000,
} as const;

export const updateUserPayments = async (
    databaseUser: any,
    productType: keyof typeof intelligentActsMap,
    sessionID: string,
) => {
    if (!Object.keys(intelligentActsMap).includes(productType)) {
        throw new Error('Invalid product type');
    }

    const intelligentActs = databaseUser.intelligentActs
        + intelligentActsMap[productType];

    const payment: UserPayment = {
        productType,
        sessionID,
    };

    await database.update(users).set({
        intelligentActs,
        payments: JSON.stringify([
            ...parseUserPayments(databaseUser),
            payment,
        ]),
    }).where(
        eq(users.id, databaseUser.id),
    );
}


export const decreaseIntelligentAct = async (
    databaseUser: any,
) => {
    if (databaseUser.freeIntelligentActs > 0) {
        const freeIntelligentActs = databaseUser.freeIntelligentActs - 1;

        await database.update(users).set({
            freeIntelligentActs,
        }).where(
            eq(users.id, databaseUser.id),
        );

        return true;
    }

    if (databaseUser.intelligentActs < 1) {
        return false;
    }

    const intelligentActs = databaseUser.intelligentActs - 1;

    await database.update(users).set({
        intelligentActs,
    }).where(
        eq(users.id, databaseUser.id),
    );

    return true;
}
