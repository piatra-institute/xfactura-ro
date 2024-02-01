import { googleLogout } from '@react-oauth/google';

import {
    ENVIRONMENT,
} from '@/data';

import localStorage, {
    localKeys,
} from '@/data/localStorage';



export const logout = async () => {
    await fetch(ENVIRONMENT.API_DOMAIN + '/logout', {
        method: 'POST',
        credentials: 'include',
    }).catch((error) => {
        console.error(error);
    });

    googleLogout();

    localStorage.user = null;
    localStorage.set(localKeys.user, null);
}
