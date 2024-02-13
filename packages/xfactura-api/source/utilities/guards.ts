import type {
    Request,
    Response,
} from 'express';

import {
    getGoogleUser,
    getDatabaseUser,
} from '../logic/getUser';

import {
    logger,
} from '../utilities';

import {
    getAuthTokens,
} from '../utilities/cookies';



export const guardAIRequest = async (
    request: Request,
    response: Response,
) => {
    const {
        accessToken,
        refreshToken,
    } = getAuthTokens(request);
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

    return {
        accessToken,
        refreshToken,
        tokensUser,
        databaseUser,
    };
}
