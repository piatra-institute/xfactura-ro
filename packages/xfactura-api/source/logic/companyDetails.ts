import { v4 as uuid } from 'uuid';

import {
    eq,
} from 'drizzle-orm';

import database from '../database';
import {
    companyDetails,
} from '../database/schema/companyDetails';




export const getCompanyDetails = async (
    vatNumber: string,
) => {
    return await database.query.companyDetails.findFirst({
        where: eq(companyDetails.vatNumber, vatNumber),
    });
}


export const storeCompanyDetails = async (
    vatNumber: string,
    data: any,
) => {
    const newCompanyDetails = {
        id: uuid(),
        vatNumber,
        data: JSON.stringify(data),
    };

    return await database.insert(companyDetails).values({
        ...newCompanyDetails,
    });
}
