import { googleLogout } from '@react-oauth/google';

import {
    ENVIRONMENT,

    User,
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


export const computeTotalIntelligentActs = (
    user: User,
) => {
    return (user.intelligentActs || 0) + (user.freeIntelligentActs || 0);
}
