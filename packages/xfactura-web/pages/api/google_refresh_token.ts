import type {
    NextApiRequest,
    NextApiResponse,
} from 'next';



export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<any>,
) {
    res.send('google_refresh_token');
}
