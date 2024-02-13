import {
    Readable,
} from 'node:stream';

import { v4 as uuid } from 'uuid';



export const logger = (
    type: 'info' | 'error' | 'warn' = 'info',
    ...message: any
) => {
    console[type](message);
}


export function createStreamFromObject(
    data: any,
) {
    const readableStream = new Readable({
        objectMode: true,
        read() {
            const buffer = Buffer.from(JSON.stringify(data));

            this.push(buffer);
            this.push(null);
        },
    });

    return readableStream;
}


export const composeFilename = (
    type: string,
    extension: string = '.json',
) => {
    const date =  new Date().toISOString().split('.')[0].replace(/:/g, '-');
    return `xfactura-ro-${type}-${date}-${uuid()}${extension}`;
}
