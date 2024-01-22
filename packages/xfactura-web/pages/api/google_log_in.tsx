import type {
    NextApiRequest,
    NextApiResponse,
} from 'next';

import {
    OAuth2Client,
} from 'google-auth-library';



const oAuth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'postmessage',
);


export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<any>,
) {
    const { tokens } = await oAuth2Client.getToken(req.body.code);

    res.json(tokens);
}
