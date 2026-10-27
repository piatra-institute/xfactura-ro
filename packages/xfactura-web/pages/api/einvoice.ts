import path from 'node:path';
import { NodePHP } from '@php-wasm/node';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResponseData } from '@/data';
import { logger } from '@/logic/utilities';

let runtime: Promise<NodePHP> | undefined;
let queue = Promise.resolve();

function loadPHP() {
  runtime ??= NodePHP.load('8.0', {
    requestHandler: { documentRoot: '/srv', absoluteUrl: 'http://localhost:3001' },
  })
    .then((php) => {
      php.mkdir('/srv');
      php.chdir('/srv');
      php.mount(path.join(process.cwd(), 'node-php'), '/srv');
      return php;
    })
    .catch((error) => {
      runtime = undefined;
      throw error;
    });
  return runtime;
}

function generate(body: unknown) {
  // The shared PHP runtime handles one request at a time.
  const result = queue.then(async () => {
    const php = await loadPHP();
    return php.request({
      method: 'POST',
      url: '/run.php',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  });
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ResponseData>) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ status: false });
    return;
  }
  try {
    const response = await generate(req.body);
    if (response.httpStatusCode >= 400 || !response.text.trimStart().startsWith('<?xml')) {
      res.status(400).json({ status: false });
      return;
    }
    res.status(200).json({ status: true, data: response.text });
  } catch (error) {
    logger('error', error);
    res.status(400).json({ status: false });
  }
}
