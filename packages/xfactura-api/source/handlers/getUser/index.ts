import type {
    Request,
    Response,
} from 'express';

import {
    google,
} from 'googleapis';

import {
    logger,
} from '../../utilities';

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

        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
        });

        let result: any = null;

        try {
            result = await oauth2Client.getTokenInfo(tokens.accessToken);
        } catch (error) {
            result = await new Promise((resolve, _reject) => {
                oauth2Client.refreshAccessToken(async (error, tokens) => {
                    if (error) {
                        resolve(null);
                        return;
                    }

                    const data = await oauth2Client.getTokenInfo(tokens?.access_token || '');
                    resolve(data);
                });
            });
        }

        if (!result) {
            response.status(200).json({
                status: false,
            });
            return;
        }

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
