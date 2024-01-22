import {
    useState,
    useEffect,
    Dispatch,
    SetStateAction,
} from 'react';

import {
    useDebouncedCallback,
} from 'use-debounce';

import {
    NewParty,
    partyText,
    partyFields,
} from '../../data';

import localStorage, {
    localKeys,
} from '../../data/localStorage';

import Subtitle from '../../components/Subtitle';
import Input from '../../components/Input';

import {
    getCompanyDetails,
} from '../../logic/requests';

import {
    normalizePartyName,
    normalizePartyCity,
    normalizePartyCounty,
    normalizeVatNumber,
    verifyInputVatNumber,
    verifyPartyData,
} from '../../logic/validation';



export default function Party({
    kind,
    title,
    data,
    setParty,
}: {
    kind: 'seller' | 'buyer';
    title: string;
    data: NewParty;
    setParty: Dispatch<SetStateAction<NewParty>>;
}) {
    const [
        loadingVatNumber,
        setLoadingVatNumber,
    ] = useState(false);

    const [
        usingLocalData,
        setUsingLocalData,
    ] = useState(false);


    const checkVatNumber = useDebouncedCallback(async (
        value: string,
    ) => {
        try {
            const vatNumber = verifyInputVatNumber(value);
            if (localStorage.usingStorage && localStorage.companies[vatNumber]) {
                const localStorageData = localStorage.companies[vatNumber];
                if (localStorageData && verifyPartyData(localStorageData)) {
                    setParty(localStorageData);
                    setUsingLocalData(true);
                    return;
                }
            }

            setLoadingVatNumber(true);
            const request: any = await getCompanyDetails(vatNumber);
            setLoadingVatNumber(false);
            if (request && request.status) {
                if (usingLocalData) {
                    return;
                }

                const {
                    adresa_domiciliu_fiscal,
                    adresa_sediu_social,
                    date_generale,
                } = request.data;

                const name = date_generale.denumire;
                const address = adresa_domiciliu_fiscal.ddenumire_Strada
                    ? (adresa_domiciliu_fiscal.ddenumire_Strada + ' ' + adresa_domiciliu_fiscal.dnumar_Strada)
                    : adresa_sediu_social.sdenumire_Strada
                        ? (adresa_sediu_social.sdenumire_Strada + ' ' + adresa_sediu_social.snumar_Strada)
                        : '';
                const city = adresa_domiciliu_fiscal.ddenumire_Localitate || adresa_sediu_social.sdenumire_Localitate || '';
                const county = adresa_domiciliu_fiscal.ddenumire_Judet || adresa_sediu_social.sdenumire_Judet || '';

                setParty(prevValues => ({
                    ...prevValues,
                    vatNumber: normalizeVatNumber(vatNumber),
                    name: name ? normalizePartyName(name) : prevValues.name,
                    address: address ? address : prevValues.address,
                    city: city ? normalizePartyCity(city) : prevValues.city,
                    county: county ? normalizePartyCounty(county) : prevValues.county,
                    country: 'România',
                }));
            } else {
                setParty(prevValues => ({
                    ...prevValues,
                    vatNumber: normalizeVatNumber(vatNumber),
                }));
            }
        } catch (error) {
            setLoadingVatNumber(false);
            setParty(prevValues => ({
                ...prevValues,
                vatNumber: value,
            }));
            return;
        }
    });

    const updateParty = (
        type: typeof partyFields[number],
    ) => {
        return async (
            value: string,
        ) => {
            if (type === 'vatNumber' && verifyInputVatNumber(value).length > 5) {
                setParty(prevValues => ({
                    ...prevValues,
                    vatNumber: value,
                }));

                checkVatNumber(value);
                return;
            }

            setParty(prevValues => ({
                ...prevValues,
                [type]: value,
            }));
        }
    }


    useEffect(() => {
        if (verifyPartyData(data)) {
            localStorage.set(
                `${localKeys.company}${data.vatNumber}`,
                data,
            );
        }
    }, [
        data,
    ]);

    useEffect(() => {
        if (kind === 'seller' && verifyPartyData(data)) {
            localStorage.set(
                localKeys.defaultSeller,
                data.vatNumber,
            );
        }
    }, [
        kind,
        data,
    ]);

    useEffect(() => {
        if (
            kind === 'seller'
            && localStorage.usingStorage
            && localStorage.defaultSeller
        ) {
            const defaultData = localStorage.companies[localStorage.defaultSeller];
            if (!defaultData) {
                return;
            }

            if (verifyPartyData(defaultData)) {
                setParty(defaultData);
            }
        }
    }, [
        kind,
        setParty,
    ]);

    useEffect(() => {
        if (data.vatNumber.length > 5) {
            checkVatNumber(data.vatNumber);
        }
    }, [
        data.vatNumber,
        checkVatNumber,
    ]);


    return (
        <div
            className="max-w-[400px] md:w-1/2 min-h-[300px] p-4 md:p-8"
        >
            <Subtitle
                text={title}
            />

            <div>
                {partyFields.map(field => {
                    // if (field === 'county') {
                    //     return (
                    //         <div
                    //             key={kind + field}
                    //         >
                    //             TODO dropdown
                    //         </div>
                    //     );
                    // }

                    return (
                        <div
                            key={kind + field}
                        >
                            <Input
                                text={partyText[field]}
                                value={data[field]}
                                setValue={updateParty(field)}
                                loading={field === 'vatNumber' && loadingVatNumber}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
