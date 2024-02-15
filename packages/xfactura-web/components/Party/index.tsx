import {
    useRef,
    useState,
    useEffect,
} from 'react';

import {
    useDebouncedCallback,
} from 'use-debounce';

import {
    Company,
    companyText,
    companyFields,
} from '@/data';

import Subtitle from '@/components/Subtitle';
import Input from '@/components/Input';

import {
    getCompanyDetails,
} from '@/logic/requests';

import {
    normalizePartyName,
    normalizePartyCity,
    normalizePartyCounty,
    normalizeVatNumber,
    verifyInputVatNumber,
    verifyPartyData,
} from '@/logic/validation';

import useStore from '@/store';



export default function Party({
    kind,
    title,
    data,
    setParty,
    styleless,
}: {
    kind: 'seller' | 'buyer';
    title: string;
    data: Company;
    setParty: (company: Company) => void;
    styleless?: boolean;
}) {
    // #region references
    const mountedTime = useRef(Date.now());
    // #endregion references


    // #region state
    const {
        usingLocalStorage,
        companies,
        defaultSeller,
        setDefaultSeller,
    } = useStore();

    const [
        loadingVatNumber,
        setLoadingVatNumber,
    ] = useState(false);

    const [
        usingLocalData,
        setUsingLocalData,
    ] = useState(false);

    const [
        multipleChoicesName,
        setMultipleChoicesName,
    ] = useState<string[]>();
    // #endregion state


    // #region handlers
    const checkLocalCompany = (
        value: string,
    ) => {
        const vatNumber = verifyInputVatNumber(value);
        const companyData = companies['RO' + vatNumber];

        if (usingLocalStorage
            && companyData
            && verifyPartyData(companyData)
        ) {
            setParty(companyData);
            setUsingLocalData(true);
            setLoadingVatNumber(false);
            return true;
        }

        return false;
    }

    const checkVatNumber = useDebouncedCallback(async (
        value: string,
    ) => {
        try {
            const now = Date.now();
            if (now - mountedTime.current < 3000) {
                return;
            }

            if (verifyPartyData(data)) {
                return;
            }

            const vatNumber = verifyInputVatNumber(value);

            setLoadingVatNumber(true);
            const request: any = await getCompanyDetails(vatNumber);
            setLoadingVatNumber(false);
            if (request && request.status) {
                if (usingLocalData) {
                    return;
                }

                const {
                    name,
                    address,
                    city,
                    county,
                } = request.data;

                setParty({
                    ...data,
                    vatNumber: normalizeVatNumber(vatNumber),
                    name: name ? normalizePartyName(name) : data.name,
                    address: address ? address : data.address,
                    city: city ? normalizePartyCity(city) : data.city,
                    county: county ? normalizePartyCounty(county) : data.county,
                    country: 'România',
                });
            } else {
                setParty({
                    ...data,
                    vatNumber: normalizeVatNumber(vatNumber),
                });
            }
        } catch (error) {
            setLoadingVatNumber(false);
            setParty({
                ...data,
                vatNumber: value,
            });
            return;
        }
    }, 2500);

    const updateParty = (
        type: typeof companyFields[number],
    ) => {
        return async (
            value: string,
        ) => {
            if (type === 'vatNumber' && verifyInputVatNumber(value).length > 5) {
                setParty({
                    ...data,
                    vatNumber: value,
                });

                setLoadingVatNumber(true);
                const local = checkLocalCompany(value);
                if (!local) {
                    checkVatNumber(value);
                }
                return;
            }

            setParty({
                ...data,
                [type]: value,
            });
        }
    }
    // #endregion handlers


    // #region effects
    /** Default seller */
    useEffect(() => {
        if (
            kind === 'seller'
            && verifyPartyData(data)
            && defaultSeller !== data.vatNumber
        ) {
            setDefaultSeller(data.vatNumber);
        }
    }, [
        kind,
        data,
        defaultSeller,
        setDefaultSeller,
    ]);

    /** Seller */
    useEffect(() => {
        if (kind !== 'seller' || !usingLocalStorage || !defaultSeller) {
            return;
        }

        const defaultSellerData = companies[defaultSeller];
        if (!defaultSellerData) {
            return;
        }

        if (verifyPartyData(defaultSellerData)
            && !data.vatNumber
            && !data.name
            && !data.county
            && !data.city
            && !data.address
        ) {
            setParty(defaultSellerData);
        }
    }, [
        kind,
        usingLocalStorage,
        defaultSeller,
        companies,
        data,
        setParty,
    ]);

    /** Check VAT */
    useEffect(() => {
        if (usingLocalData) {
            return;
        }

        if (data.vatNumber.length > 5) {
            checkVatNumber(data.vatNumber);
        }
    }, [
        data.vatNumber,
        checkVatNumber,
        usingLocalData,
    ]);

    useEffect(() => {
        if (!data.name) {
            setMultipleChoicesName([]);
            return;
        }

        const name = data.name.toLowerCase();
        const choices = Object.keys(companies)
            .filter(key => companies[key].name.toLowerCase().includes(name))
            .map(key => companies[key].name);

        if (choices.length === 1 && choices[0] === data.name) {
            setMultipleChoicesName([]);
            return;
        }

        setMultipleChoicesName(choices);
    }, [
        data.name,
        companies,
    ]);
    // #endregion effects


    // #region render
    return (
        <div
            className={styleless ? '' : 'max-w-[400px] md:w-1/2 min-h-[300px] p-4 md:p-8'}
        >
            <Subtitle
                text={title}
            />

            <div>
                {companyFields.map(field => {
                    // if (field === 'county') {
                    //     return (
                    //         <div
                    //             key={kind + field}
                    //         >
                    //             TODO dropdown
                    //         </div>
                    //     );
                    // }

                    if (field === 'name') {
                        return (
                            <div
                                key={kind + field}
                            >
                                <Input
                                    text={companyText[field]}
                                    value={data[field]}
                                    setValue={updateParty(field)}
                                    multipleChoices={multipleChoicesName}
                                    atChoice={(choice) => {
                                        const companyData = Object.values(companies)
                                            .find(company => company.name === choice);
                                        if (!companyData) {
                                            return;
                                        }

                                        setParty(companyData);
                                        setUsingLocalData(true);
                                        setMultipleChoicesName([]);
                                    }}
                                />
                            </div>
                        );
                    }

                    return (
                        <div
                            key={kind + field}
                        >
                            <Input
                                text={companyText[field]}
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
    // #endregion render
}
