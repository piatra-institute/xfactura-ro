import type {
    Request,
    Response,
} from 'express';

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

export default async function handler(
    req: Request,
    res: Response,
) {
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
            res.status(400).json({
                status: false,
            });
            return;
        }

        if (map[vatNumber]) {
            res.status(200).json({
                status: true,
                data: map[vatNumber],
            });
            return;
        }

        const keys = Object.keys(map);
        if (keys.length > MAP_LIMIT) {
            for (const key of keys) {
                delete map[key];
            }
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
            });

        if (!result || result.cod !== 200) {
            res.status(404).json({
                status: false,
            });
            return;
        }

        const entity = result.found[0];

        const {
            adresa_domiciliu_fiscal,
            adresa_sediu_social,
            date_generale,
        } = entity;

        const name = date_generale.denumire;
        const address = adresa_domiciliu_fiscal.ddenumire_Strada
            ? (adresa_domiciliu_fiscal.ddenumire_Strada + ' ' + adresa_domiciliu_fiscal.dnumar_Strada)
            : adresa_sediu_social.sdenumire_Strada
                ? (adresa_sediu_social.sdenumire_Strada + ' ' + adresa_sediu_social.snumar_Strada)
                : '';
        const city = adresa_domiciliu_fiscal.ddenumire_Localitate || adresa_sediu_social.sdenumire_Localitate || '';
        const county = adresa_domiciliu_fiscal.ddenumire_Judet || adresa_sediu_social.sdenumire_Judet || '';
        const parsedEntity = {
            name,
            address,
            city,
            county,
        };

        map[vatNumber] = parsedEntity;

        res.status(200).json({
            status: true,
            data: parsedEntity,
        });
    } catch (error) {
        logger('error', error);

        res.status(400).json({
            status: false,
        });
    }
}
