import { cookies } from 'next/headers';

import {
    ENVIRONMENT,
} from '@/data';



const getCookie = async (name: string) => {
    return cookies().get(name)?.value ?? '';
}

const getUser = async () => {
    const cookie_XFCT_AT = await getCookie('XFCT_AT');
    const cookie_XFCT_RT = await getCookie('XFCT_RT');

    const response = await fetch(
        ENVIRONMENT.API_DOMAIN + '/get-user',
        {
            method: 'POST',
            // cache: 'no-cache',
            headers: {
                Cookie: `XFCT_AT=${cookie_XFCT_AT};XFCT_RT=${cookie_XFCT_RT};`
            },
        },
    ).catch((error) => {
        console.error(error);
    });
    if (!response) {
        return;
    }
    const data = await response.json();

    return data;
}


export default getUser;
