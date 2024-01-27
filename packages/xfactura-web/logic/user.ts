import { googleLogout } from '@react-oauth/google';

import localStorage, {
    localKeys,
} from '@/data/localStorage';



export const logout = async () => {
    googleLogout();

    localStorage.user = null;
    localStorage.set(localKeys.user, null);
}
