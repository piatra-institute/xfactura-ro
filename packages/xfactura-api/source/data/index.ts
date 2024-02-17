export interface UserPayment {
    productType: string;
    sessionID: string;
}


export const ENVIRONMENT = {
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
}
