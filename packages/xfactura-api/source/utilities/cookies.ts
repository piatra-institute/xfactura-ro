import type {
    Request,
    Response,
} from 'express';

import {
    ENVIRONMENT,
} from '../data';



const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
export const COOKIE_ACCESS_TOKEN = 'XFCT_AT';
export const COOKIE_REFRESH_TOKEN = 'XFCT_RT';
export const AUTHORIZATION_HEADER = 'authorization';
export const AUTHORIZATION_REFRESH_HEADER = 'authorization-refresh';


export const setAuthCookies = (
    response: Response,
    tokens: {
        accessToken: string;
        refreshToken: string;
    },
) => {
    response.cookie(COOKIE_ACCESS_TOKEN, tokens.accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: ONE_YEAR,
        domain: ENVIRONMENT.COOKIE_DOMAIN,
    });
    response.cookie(COOKIE_REFRESH_TOKEN, tokens.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: ONE_YEAR,
        domain: ENVIRONMENT.COOKIE_DOMAIN,
    });
}


export const clearAuthCookies = (
    response: Response,
) => {
    response.clearCookie(COOKIE_ACCESS_TOKEN, {
        path: '/',
        domain: ENVIRONMENT.COOKIE_DOMAIN,
    });
    response.clearCookie(COOKIE_REFRESH_TOKEN, {
        path: '/',
        domain: ENVIRONMENT.COOKIE_DOMAIN,
    });
}


export const getAuthCookies = (
    request: Request,
) => {
    const accessToken = request.cookies[COOKIE_ACCESS_TOKEN] || '';
    const refreshToken = request.cookies[COOKIE_REFRESH_TOKEN] || '';

    return {
        accessToken,
        refreshToken,
    };
}


export const getAuthTokens = (
    request: Request,
) => {
    const accessToken = (request.headers[AUTHORIZATION_HEADER] as string)?.
        replace('Bearer ', '') || '';
    const refreshToken = (request.headers[AUTHORIZATION_REFRESH_HEADER] as string)?.
        replace('Bearer Refresh ', '') || '';

    return {
        accessToken,
        refreshToken,
    };
}
