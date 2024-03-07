import type {
    Request,
    Response,
} from 'express';

import {
    getCompanyDetails,
    storeCompanyDetails,
} from '../../logic/companyDetails';

import {
    logger,
} from '../../utilities';



const API = 'https://webservicesp.anaf.ro/PlatitorTvaRest/api/v8/ws/tva';

const map: Record<string, Record<string, any>> = {};
const MAP_LIMIT = 10_000;

type RequestBody = {
    vatNumber: string;
}

type ResponseData = any;

const verifyInputVatNumber = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .toUpperCase()
        .trim()
        .replace(/\s/g, '')
        .replace('RO', '');
}

const parseCompanyDetails = (
    data: any,
) => {
    try {
        const {
            adresa_domiciliu_fiscal,
            adresa_sediu_social,
            date_generale,
        } = data;

        const name = date_generale.denumire;
        const address = adresa_domiciliu_fiscal.ddenumire_Strada
            ? (adresa_domiciliu_fiscal.ddenumire_Strada + ' ' + adresa_domiciliu_fiscal.dnumar_Strada)
            : adresa_sediu_social.sdenumire_Strada
                ? (adresa_sediu_social.sdenumire_Strada + ' ' + adresa_sediu_social.snumar_Strada)
                : '';
        const city = adresa_domiciliu_fiscal.ddenumire_Localitate || adresa_sediu_social.sdenumire_Localitate || '';
        const county = adresa_domiciliu_fiscal.ddenumire_Judet || adresa_sediu_social.sdenumire_Judet || '';
        const parsedCompany = {
            name,
            address,
            city,
            county,
        };

        return parsedCompany;
    } catch (error) {
        logger('error', error);
    }
}


export default async function handler(
    req: Request,
    res: Response,
) {
    const reject = (code = 404) => {
        res.status(code).json({
            status: false,
        });
    }
    const success = (data: any) => {
        res.status(200).json({
            status: true,
            data,
        });
    }

    try {
        const {
            vatNumber,
        } = req.body as RequestBody;
        const verifiedVatNumber = verifyInputVatNumber(vatNumber);
        if (
            !verifiedVatNumber
            || verifiedVatNumber.length < 5
            || verifiedVatNumber.length > 12
        ) {
            return reject(400);
        }

        if (map[vatNumber]) {
            return success(map[vatNumber]);
        }

        const keys = Object.keys(map);
        if (keys.length > MAP_LIMIT) {
            for (const key of keys) {
                delete map[key];
            }
        }

        const databaseCompany = await getCompanyDetails(verifiedVatNumber);
        if (databaseCompany) {
            const parsedCompany = parseCompanyDetails(databaseCompany.data);
            if (!parsedCompany) {
                return reject();
            }
            map[vatNumber] = parsedCompany;
            return success(parsedCompany);
        }

        const result: ResponseData = await fetch(API, {
            method: 'POST',
            mode: 'no-cors',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([
                {
                    cui: verifiedVatNumber,
                    data: new Date().toISOString().split('T')[0],
                },
            ]),
        })
            .then((response) => {
                return response.json();
            })
            .catch((error) => {
                logger('error', error);
                return reject(400);
            });
        if (!result || result.cod !== 200) {
            return reject();
        }

        const parsedCompany = parseCompanyDetails(result.found[0]);
        if (!parsedCompany) {
            return reject();
        }

        map[vatNumber] = parsedCompany;
        await storeCompanyDetails(verifiedVatNumber, result.found[0]);
        return success(parsedCompany);
    } catch (error) {
        logger('error', error);

        return reject(400);
    }
}
