import type {
    Request,
    Response,
} from 'express';

import {
    getGoogleUser,
    getDatabaseUser,
} from '../../logic/getUser';

import {
    decreaseIntelligentAct,
} from '../../logic/updateUser';

import {
    logger,
} from '../../utilities';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const accessToken = request.headers['authorization']?.replace('Bearer ', '');
        const refreshToken = (request.headers['authorization-refresh'] as string)?.replace('Bearer Refresh ', '');

        if (!accessToken || !refreshToken) {
            response.status(401).json({
                status: false,
            });
            return;
        }

        const tokensUser = await getGoogleUser({
            accessToken,
            refreshToken,
        });
        if (!tokensUser) {
            logger('warn', 'Tokens user not found');

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

        const decreased = await decreaseIntelligentAct(databaseUser);
        if (!decreased) {
            logger('warn', 'Intelligent act not decreased');

            response.status(402).json({
                status: false,
            });
            return;
        }

        response.json({
            status: true,
        });
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
