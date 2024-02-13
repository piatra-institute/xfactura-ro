import type {
    Request,
    Response,
} from 'express';



const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
export const COOKIE_ACCESS_TOKEN = 'XFCT_AT';
export const COOKIE_REFRESH_TOKEN = 'XFCT_RT';


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
        domain: process.env.COOKIE_DOMAIN,
    });
    response.cookie(COOKIE_REFRESH_TOKEN, tokens.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: ONE_YEAR,
        domain: process.env.COOKIE_DOMAIN,
    });
}


export const clearAuthCookies = (
    response: Response,
) => {
    response.clearCookie(COOKIE_ACCESS_TOKEN);
    response.clearCookie(COOKIE_REFRESH_TOKEN);
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
