import type {
    Request,
    Response,
} from 'express';

import {
    logger,
    createStreamFromObject,
    composeFilename,
} from '../../utilities';

import {
    guardAIRequest,
} from '../../utilities/guards';

import {
    uploadFile,
} from '../../utilities/google';



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
            accessToken,
            refreshToken,
        } = aiRequest;

        const {
            prompt,
            response: promptResponse,
        } = request.body;
        if (!prompt || !promptResponse) {
            response.status(400).json({
                status: false,
            });
            return;
        }

        const data = {
            prompt,
            response: promptResponse,
        };
        const fileName = composeFilename('text');
        const fileStream = createStreamFromObject(data);
        await uploadFile(
            fileName,
            fileStream,
            accessToken,
            refreshToken,
        );

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
