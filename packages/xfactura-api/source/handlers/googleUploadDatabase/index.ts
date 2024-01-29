import {
    Readable,
} from 'node:stream';

import {
    Request,
    Response,
} from 'express';

import {
    google,
} from 'googleapis';

import {
    searchFile,
} from '../../utilities/google';

import {
    logger,
} from '../../utilities';



const googleUploadDatabase = async (
    request: Request,
    response: Response,
) => {
    try {
        const {
            access_token,
            refresh_token,
            fileName,
        } = request.body;

        const fileBuffer = request.file!.buffer;

        const fileStream = new Readable();
        fileStream.push(fileBuffer);
        fileStream.push(null);


        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({
            access_token,
            refresh_token,
        });


        const googleDrive = google.drive({
            version: 'v3',
            auth: oauth2Client,
        });

        const fileID = await searchFile(googleDrive, fileName);
        if (fileID) {
            await googleDrive.files.update(
                {
                    fileId: fileID,
                    media: {
                        body: fileStream,
                    },
                },
            );

            response.json({
                status: true,
            });
            return;
        }

        await googleDrive.files.create(
            {
                requestBody: {
                    name: fileName,
                    mimeType: 'application/octet-stream',
                },
                media: {
                    body: fileStream,
                },
            },
        );

        response.json({
            status: true,
        });
    } catch (error) {
        logger('error', error);

        response.json({
            status: false,
        });
    }
}


export default googleUploadDatabase;
