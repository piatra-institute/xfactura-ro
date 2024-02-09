import type {
    Request,
    Response,
} from 'express';

import {
    getTokensUser,
    getDatabaseUser,
} from '../../logic/getUser';

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

            response.status(404).json({
                status: false,
            });
            return;
        }

        const databaseUser = await getDatabaseUser(tokensUser);
        if (!databaseUser) {
            logger('warn', 'Database user not found');

            response.status(404).json({
                status: false,
            });
            return;
        }

        response.json({
            status: true,
            data: {
                ...databaseUser,
                payments: JSON.parse(databaseUser.payments),
            },
        });
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
