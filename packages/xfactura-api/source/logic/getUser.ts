import type {
    Request,
    Response,
} from 'express';

import {
    eq,
} from 'drizzle-orm';

import database from '../database';
import {
    users,
} from '../database/schema/users';

import newGoogleClient from '../services/google';

import {
    getAuthCookies,
    setAuthCookies,
} from '../utilities/cookies';



export const getGoogleUser = async (
    tokens: {
        accessToken: string,
        refreshToken: string,
    },
    response?: Response,
) => {
    const googleClient = newGoogleClient();
    googleClient.setCredentials({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
    });

    let result: any = null;

    try {
        result = await googleClient.getTokenInfo(tokens.accessToken);
    } catch (error) {
        result = await new Promise((resolve, _reject) => {
            googleClient.refreshAccessToken(async (error, tokens) => {
                if (error
                    || !tokens
                    || !tokens.access_token
                    || !tokens.refresh_token
                ) {
                    resolve(null);
                    return;
                }

                if (response) {
                    setAuthCookies(response, {
                        accessToken: tokens.access_token,
                        refreshToken: tokens.refresh_token,
                    });
                }

                const data = await googleClient.getTokenInfo(tokens.access_token);
                resolve(data);
            });
        });
    }

    return result;
}


export const getTokensUser = async (
    request: Request,
    response: Response,
) => {
    const tokens = getAuthCookies(request);
    if (!tokens.accessToken || !tokens.refreshToken) {
        return;
    }

    const user = await getGoogleUser(tokens, response);

    return user;
}


export const getDatabaseUser = async (
    user: any,
) => {
    return await database.query.users.findFirst({
        where: eq(users.email, user.email),
    });
}
