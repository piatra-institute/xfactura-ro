import {
    eq,
} from 'drizzle-orm';

import database from '../database';
import {
    users,
} from '../database/schema/users';



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

    await database.update(users).set({
        intelligentActs,
        payments: JSON.stringify([
            ...JSON.parse(databaseUser.payments || '[]'),
            {
                amount: productType,
                sessionID,
            },
        ]),
    }).where(
        eq(users.email, databaseUser.email),
    );
}
