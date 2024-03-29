import type {
    Request,
    Response,
} from 'express';

import {
    decreaseIntelligentAct,
} from '../../logic/updateUser';

import {
    logger,
} from '../../utilities';

import {
    guardAIRequest,
} from '../../utilities/guards';



export default async function handler(
    request: Request,
    response: Response,
) {
    try {
        const aiRequest = await guardAIRequest(request, response);
        if (!aiRequest) {
            return;
        }

        const {
            databaseUser,
        } = aiRequest;

        const decreased = await decreaseIntelligentAct(databaseUser);
        if (!decreased) {
            logger('warn', 'Intelligent act not decreased');

            response.status(402).json({
                status: false,
            });
            return;
        }

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
