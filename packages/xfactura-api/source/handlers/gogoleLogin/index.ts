import type {
    Request,
    Response,
} from 'express';

import {
    jwtDecode,
} from 'jwt-decode';

import googleClient from '../../services/google';

import {
    logger,
} from '../../utilities';

import {
    setAuthCookies,
} from '../../utilities/cookies';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const { tokens } = await googleClient.getToken(request.body.code);
        const decoded: any = jwtDecode(tokens.id_token || '');

        if (!tokens.access_token || !tokens.refresh_token) {
            response.status(400).json({
                status: false,
            });
            return;
        }

        const {
            email,
            name,
            picture,
        } = decoded;

        setAuthCookies(response, {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
        });

        response.json({
            status: true,
            data: {
                email,
                name,
                picture,
            },
        });
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
