import {
    Readable,
} from 'node:stream';

import {
    Request,
    Response,
} from 'express';

import {
    google,
    drive_v3,
} from 'googleapis';



async function createFolder(
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
    } catch (err) {
        console.log(err);
    }
}

async function searchFolder(
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
    } catch (err) {
        console.log(err);
    }
}

async function searchFile(
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

        return res.data.files[0].id;
    } catch (err) {
        console.log(err);
    }
}



const uploadDatabaseGoogleDrive = async (
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
        console.log(error);

        response.json({
            status: false,
        });
    }
}


export default uploadDatabaseGoogleDrive;
