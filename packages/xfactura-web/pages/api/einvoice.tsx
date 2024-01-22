import path from 'node:path';

import {
    NodePHP,
} from '@php-wasm/node';

import type {
    NextApiRequest,
    NextApiResponse,
} from 'next';

import {
    ResponseData,
} from '../../data';

import {
    logger,
} from '../../logic/utilities';



class PHPRunner {
    php: NodePHP | null;

    constructor() {
        this.php = null;
        this.load();
    }

    public async load() {
        if (this.php) {
            return;
        }

        this.php = await NodePHP.load('8.0', {
            requestHandler: {
                documentRoot: '/srv',
                absoluteUrl: 'http://localhost:3001',
            },
        });

        this.php.mkdir('/srv');
        this.php.chdir('/srv');

        this.php.mount(
            path.join(
                process.cwd(),
                '/node-php',
            ),
            '/srv',
        );
    }

    public async request(
        body: any,
    ) {
        if (!this.php) {
            return;
        }

        return await this.php.request({
            method: 'POST',
            url: '/run.php',
            body,
        });
    }
}

const php = new PHPRunner();


export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<ResponseData>
) {
    try {
        await php.load();

        const response = await php.request(req.body);
        if (!response) {
            res.status(400).json({
                status: false,
            });
            return;
        }

        res.status(200).json({
            status: true,
            data: response.text,
        });
    } catch (error) {
        logger('error', error);

        res.status(400).json({
            status: false,
        });
    }
}
