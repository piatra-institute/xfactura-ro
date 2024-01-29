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
    respone: Response,
) {
    try {
        const { tokens } = await oAuth2Client.getToken(request.body.code);
        const decoded: any = jwtDecode(tokens.id_token || '');

        // store
        // tokens.access_token
        // tokens.refresh_token

        const {
            email,
            name,
            picture,
        } = decoded;

        respone.json({
            status: true,
            data: {
                email,
                name,
                picture,
            },
        });
    } catch (error) {
        logger('error', error);

        respone.status(500).json({
            status: false,
        });
    }
}
