import {
    ENVIRONMENT,
    COMPANY_DETAILS_API,
    EINVOICE_API,
    UPLOAD_AUDIO_API,
    UPLOAD_FILE_API,
    UPLOAD_TEXT_API,
} from '../data';

import {
    logger,
} from './utilities';



export const getCompanyDetails = async (
    vatNumber: string,
) => {
    if (!ENVIRONMENT.X_DOMAIN) {
        return;
    }

    const controller = new AbortController();
    const timeout = 5_000;
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const request = await fetch(COMPANY_DETAILS_API, {
            method: 'POST',
            mode: 'no-cors',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                vatNumber,
            }),
            signal: controller.signal,
        });
        clearTimeout(id);

        const data = await request.json();

        return data;
    } catch (error) {
        logger('error', error);
        clearTimeout(id);
    }
}

export const getUser = async () => {
    if (!ENVIRONMENT.API_DOMAIN) {
        return;
    }

    return fetch(ENVIRONMENT.API_DOMAIN + '/get-user', {
        method: 'POST',
        credentials: 'include',
    })
        .then((response) => response.json())
        .catch((error) => {
            logger('error', error);
        });
}


export const getEInvoice = async (
    data: any,
) => {
    if (!ENVIRONMENT.X_DOMAIN) {
        return;
    }

    return fetch(EINVOICE_API, {
        method: 'POST',
        mode: 'no-cors',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
    })
        .then((response) => response.json())
        .then((data) => {
            return data;
        })
        .catch((error) => {
            logger('error', error);
        });
}


export const uploadAudio = async (
    audio: Blob,
) => {
    if (!ENVIRONMENT.AI_DOMAIN) {
        return;
    }

    const formData = new FormData();
    const id = (Math.random() + '').slice(2);
    const filename = `audio-${id}.mp3`;
    formData.append('file', audio, filename);

    return fetch(UPLOAD_AUDIO_API, {
        method: 'POST',
        credentials: 'include',
        body: formData,
    })
        .then((response) => {
            return response.json();
        })
        .catch((error) => {
            logger('error', error);
        });
}

export const uploadFile = async (
    file: File | Blob,
) => {
    if (!ENVIRONMENT.AI_DOMAIN) {
        return;
    }

    const formData = new FormData();
    const filename = file instanceof File ? file.name : 'file.png';
    formData.append('file', file, filename);

    return fetch(UPLOAD_FILE_API, {
        method: 'POST',
        credentials: 'include',
        body: formData,
    })
        .then((response) => {
            return response.json();
        })
        .catch((error) => {
            logger('error', error);
        });
}

export const uploadText = async (
    text: string,
) => {
    if (!ENVIRONMENT.AI_DOMAIN) {
        return;
    }

    return fetch(UPLOAD_TEXT_API, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text,
        }),
    })
        .then((response) => {
            return response.json();
        })
        .catch((error) => {
            logger('error', error);
        });
}



export const apiLogin = async (
    data: any,
) => {
    return fetch(ENVIRONMENT.API_DOMAIN + '/login', {
        method: 'POST',
        mode: 'no-cors',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            ...data,
        }),
    })
        .then((response) => response.json())
        .catch((error) => {
            logger('error', error);
        });
}
