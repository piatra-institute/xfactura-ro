import type {
    NextApiRequest,
    NextApiResponse,
} from 'next';



export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<any>,
) {
    console.log('google_logged_in', req.body);

    res.send('google_logged_in');

    // const { googleId, email, name, imageUrl } = req.body;

    // res.status(200).json({ googleId, email, name, imageUrl });
}
