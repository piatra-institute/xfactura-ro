import type {
    Request,
    Response,
} from 'express';

import {
    eq,
} from 'drizzle-orm';

import {
    jwtDecode,
} from 'jwt-decode';

import { v4 as uuid } from 'uuid';

import database from '../../database';
import {
    users,
} from '../../database/schema/users';

import newGoogleClient from '../../services/google';

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
        const googleClient = newGoogleClient();
        const { tokens } = await googleClient.getToken(request.body.code);
        const decoded: any = jwtDecode(tokens.id_token || '');

        if (!tokens.access_token || !tokens.refresh_token) {
            response.status(200).json({
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

        const databaseUser = await database.query.users.findFirst({
            where: eq(users.email, email),
        });
        const newUser = {
            id: uuid(),
            createdAt: new Date().toISOString(),
            email,
            name,
            picture,
            payments: JSON.stringify([]),
            intelligentActs: 0,
        };
        if (!databaseUser) {
            await database.insert(users).values({
                ...newUser,
            });
        }

        const user = databaseUser || newUser;

        response.json({
            status: true,
            data: {
                ...user,
            },
        });
    } catch (error) {
        logger('error', error);

        response.status(400).json({
            status: false,
        });
    }
}
