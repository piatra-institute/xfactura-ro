import type {
    Request,
    Response,
} from 'express';

import {
    OAuth2Client,
} from 'google-auth-library';

import {
    jwtDecode,
} from 'jwt-decode';

import {
    logger,
} from '../../utilities';



const oAuth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'postmessage',
);


export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const { tokens } = await oAuth2Client.getToken(request.body.code);
        const decoded: any = jwtDecode(tokens.id_token || '');

        const {
            email,
            name,
            picture,
        } = decoded;

        response.cookie('access_token', tokens.access_token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
        });
        response.cookie('refresh_token', tokens.refresh_token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
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
