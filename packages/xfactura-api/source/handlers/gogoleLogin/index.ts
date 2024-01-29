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



const oAuth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'postmessage',
);


export default async function handler(
    req: Request,
    res: Response,
) {
    try {
        const { tokens } = await oAuth2Client.getToken(req.body.code);
        const decoded: any = jwtDecode(tokens.id_token || '');

        // store
        // tokens.access_token
        // tokens.refresh_token

        const {
            email,
            name,
            picture,
        } = decoded;

        res.json({
            email,
            name,
            picture,
        });
    } catch (error) {
        return;
    }
}
