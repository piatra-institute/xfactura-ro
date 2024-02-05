import { googleLogout } from '@react-oauth/google';

import {
    ENVIRONMENT,
} from '@/data';

import useStore from '@/store';



export const useLogout = () => {
    const {
        setUser,
    } = useStore();

    return async () => {
        await fetch(ENVIRONMENT.API_DOMAIN + '/logout', {
            method: 'POST',
            credentials: 'include',
        }).catch((error) => {
            console.error(error);
        });

        googleLogout();

        setUser(null);
    }
}
