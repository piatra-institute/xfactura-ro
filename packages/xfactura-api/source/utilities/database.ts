import {
    UserPayment,
} from '../data';



export const parseUserPayments = (
    databaseUser: any,
): UserPayment[] => {
    return JSON.parse(databaseUser.payments || '[]');
}
