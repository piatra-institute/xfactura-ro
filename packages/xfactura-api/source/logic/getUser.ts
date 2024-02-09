import type {
    Request,
} from 'express';

import {
    eq,
} from 'drizzle-orm';

import {
    google,
} from 'googleapis';

import database from '../database';
import {
    users,
} from '../database/schema/users';

import {
    getAuthCookies,
} from '../utilities/cookies';



export const getTokensUser = async (
    request: Request,
) => {
    const tokens = getAuthCookies(request);
    if (!tokens.accessToken || !tokens.refreshToken) {
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

    return result;
}


export const getDatabaseUser = async (
    user: any,
) => {
    return await database.query.users.findFirst({
        where: eq(users.email, user.email),
    });
}
