import {
    google,
    drive_v3,
} from 'googleapis';

import {
    logger,
} from './index';

import newGoogleClient from '../services/google';



export async function createFolder(
    googleDrive: drive_v3.Drive,
    name: string,
) {
    const fileMetadata = {
        name,
        mimeType: 'application/vnd.google-apps.folder',
    };

    try {
        const file = await googleDrive.files.create({
            requestBody: fileMetadata,
            fields: 'id',
        });
        console.log('Folder Id:', file.data.id);

        return file.data.id || '';
    } catch (error) {
        logger('warn', error);
    }
}

export async function searchFolder(
    googleDrive: drive_v3.Drive,
    name: string,
) {
    try {
        const res = await googleDrive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`,
            fields: 'files(id)',
            spaces: 'drive',
        });

        if (!res.data.files) {
            return;
        }

        return res.data.files[0].id;
    } catch (error) {
        logger('warn', error);
    }
}

export async function searchFile(
    googleDrive: drive_v3.Drive,
    name: string,
) {
    try {
        const res = await googleDrive.files.list({
            q: `name='${name}' and trashed=false`,
            fields: 'files(id)',
            spaces: 'drive',
        });

        if (!res.data.files) {
            return;
        }

        const file = res.data.files[0];
        if (!file) {
            return;
        }

        return file.id;
    } catch (error) {
        logger('warn', error);
    }
}


export async function uploadFile(
    fileName: string,
    fileStream: NodeJS.ReadableStream,
    access_token: string,
    refresh_token: string,
    mimeType = 'application/octet-stream',
) {
    const googleClient = newGoogleClient();
    googleClient.setCredentials({
        access_token,
        refresh_token,
    });

    const googleDrive = google.drive({
        version: 'v3',
        auth: googleClient,
    });

    const fileID = await searchFile(googleDrive, fileName);
    if (fileID) {
        await googleDrive.files.update(
            {
                fileId: fileID,
                media: {
                    body: fileStream,
                    mimeType,
                },
            },
        );

        return;
    }

    await googleDrive.files.create(
        {
            requestBody: {
                name: fileName,
                mimeType,
            },
            media: {
                body: fileStream,
            },
        },
    );

    return;
}
