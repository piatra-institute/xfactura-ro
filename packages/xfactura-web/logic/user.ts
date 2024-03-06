import {
    useContext,
} from 'react';

import { googleLogout } from '@react-oauth/google';

import {
    ENVIRONMENT,

    User,
} from '@/data';

import useStore from '@/store';

import {
    UserContext,
} from '@/logic/context';



export const useLogout = () => {
    const {
        logoutContextUser,
    } = useContext(UserContext);

    const {
        setUser,
    } = useStore();

    return async () => {
        try {
            logoutContextUser();
            setUser(null);
            googleLogout();

            await fetch(ENVIRONMENT.API_DOMAIN + '/logout', {
                method: 'POST',
                credentials: 'include',
            }).catch((error) => {
                console.error(error);
            });
        } catch (_) {
        }
    }
}


export const computeTotalIntelligentActs = (
    user: User,
) => {
    return (user.intelligentActs || 0) + (user.freeIntelligentActs || 0);
}
