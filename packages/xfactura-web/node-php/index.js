import {
    NodePHP,
} from '@php-wasm/node';

import fs from 'node:fs';



const php = await NodePHP.load('8.0', {
	requestHandler: {
		documentRoot: '/srv',
        absoluteUrl: 'http://localhost:3001',
	},
});

php.mkdir('/srv');
php.chdir('/srv');

php.mount(process.cwd(), '/srv');



const direct = async () => {
    try {
        const data = await fs.promises.readFile('./data.json', 'utf8');
        if (!data) {
            return;
        }

        const response = await php.request({
            method: 'POST',
            url: '/run.php',
            body: data,
        });
        console.log(JSON.stringify({
            status: true,
            data: response.text,
        }));

        process.exit(0);
    } catch (error) {
        console.log(error);
    }
}


direct();
