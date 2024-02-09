import type {
    Request,
    Response,
} from 'express';

import {
    eq,
} from 'drizzle-orm';

import getUser from '../../logic/getUser';

import database from '../../database';
import {
    users,
} from '../../database/schema/users';

import {
    logger,
} from '../../utilities';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const user = await getUser(request);
        if (!user) {
            logger('warn', 'User not found');

            response.status(404).json({
                status: false,
            });
            return;
        }

        const databaseUser = await database.query.users.findFirst({
            where: eq(users.email, user.email),
        });
        if (!databaseUser) {
            logger('warn', 'Database user not found');

            response.status(404).json({
                status: false,
            });
            return;
        }

        response.json({
            status: true,
            data: {
                ...databaseUser,
            },
        });
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
