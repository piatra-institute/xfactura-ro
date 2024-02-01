import type {
    Request,
    Response,
} from 'express';

import {
    logger,
} from '../../utilities';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        response.clearCookie('access_token');
        response.clearCookie('refresh_token');

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
