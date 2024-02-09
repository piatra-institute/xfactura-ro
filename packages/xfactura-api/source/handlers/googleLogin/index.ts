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

        const databaseUser = await database.query.users.findFirst({
            where: eq(users.email, email),
        });
        if (!databaseUser) {
            await database.insert(users).values({
                id: uuid(),
                createdAt: new Date().toISOString(),
                email,
                name,
                payments: JSON.stringify([]),
                intelligentActs: 0,
            });
        }

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
