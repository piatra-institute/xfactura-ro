import type {
    Request,
    Response,
} from 'express';

import {
    logger,
} from '../../utilities';

import {
    clearAuthCookies,
} from '../../utilities/cookies';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        clearAuthCookies(response);

        response.json({
            status: true,
        });
    } catch (error) {
        logger('error', error);

        response.status(500).json({
            status: false,
        });
    }
}
