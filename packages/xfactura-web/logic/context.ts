import React from 'react';

import {
    User,
} from '@/data';



export interface IUserContext {
    user: User | null;
    logoutContextUser: () => void;
}

export const UserContext = React.createContext<IUserContext>({
    user: null,
    logoutContextUser: () => {},
});
