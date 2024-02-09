import type {
    Request,
    Response,
} from 'express';

import getUser from '../../logic/getUser';

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

            response.status(200).json({
                status: false,
            });
            return;
        }

        response.json({
            status: true,
            data: {
                email: user.email,
            },
        });
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
