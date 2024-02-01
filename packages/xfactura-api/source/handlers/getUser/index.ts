import type {
    Request,
    Response,
} from 'express';

import {
    logger,
} from '../../utilities';

import googleClient from '../../services/google';

import {
    getAuthCookies,
} from '../../utilities/cookies';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const tokens = getAuthCookies(request);

        if (!tokens.accessToken || !tokens.refreshToken) {
            response.status(200).json({
                status: false,
            });
            return;
        }

        const result = await googleClient.getTokenInfo(tokens.accessToken);

        // googleClient.refreshAccessToken((a, b) => {
        //     console.log(a, b);
        // });

        response.json({
            status: true,
            data: {
                email: result.email,
            },
        });
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
