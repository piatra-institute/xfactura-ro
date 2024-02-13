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
    obj: any,
) {
    const readableStream = new Readable({
        objectMode: true,
        read() {
            this.push(obj);
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
