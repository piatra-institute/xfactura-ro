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
    companyPlaceholder,
} from '@/data';

import {
    collapseIcon,
    expandIcon,
} from '@/data/icons';

import Subtitle from '@/components/Subtitle';
import Input, {
    MultipleChoice,
} from '@/components/Input';
import LinkButton from '@/components/LinkButton';

import {
    getCompanyDetails,
} from '@/logic/requests';

import fuzzySearch, {
    companySearcher,
} from '@/logic/searchers';

import {
    normalizeDiacritics,
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
    editing,
}: {
    kind: 'seller' | 'buyer';
    title: string;
    data: Company;
    setParty: (company: Company) => void;
    styleless?: boolean;
    editing?: boolean;
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
        expandedBuyer,
        toggleExpandedBuyer,
        expandedSeller,
        toggleExpandedSeller,
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
    ] = useState<MultipleChoice[]>();
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

        // FORCE: defaultSeller in the dependency array causes infinite loop
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        kind,
        data,
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

    /** Multiple choices */
    useEffect(() => {
        if (data.name.length < 2) {
            setMultipleChoicesName([]);
            return;
        }

        const name = normalizeDiacritics(data.name.toLowerCase().trim());

        companySearcher.indexEntities(
            Object.values(companies),
            (entity) => entity.vatNumber,
            (entity) => [entity.name],
        );
        const result = companySearcher.getMatches(new fuzzySearch.Query(
            name,
            10,
            0.2,
        ));
        if (
            result.matches.length === 0
            || result.matches.some(match => match.quality === 1)
        ) {
            setMultipleChoicesName([]);
            return;
        }

        const choices = result.matches.map((match) => {
            const {
                vatNumber,
                name,
                city,
            } = companies[match.entity.vatNumber];

            return {
                id: vatNumber,
                name,
                show: `${name} (${vatNumber} ${city})`,
            };
        });

        if (choices.length === 1 && choices[0].name === data.name) {
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
    const expanded = kind === 'seller'
        ? expandedSeller
        : expandedBuyer;

    return (
        <div
            className={styleless ? '' : 'max-w-[400px] md:w-1/2 min-h-[150px] mx-auto md:mx-0 p-2 md:p-8'}
        >
            <Subtitle
                text={title}
            />

            <div
                className="min-w-[280px]"
            >
                {companyFields.map(field => {
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
                                        if (typeof choice === 'string') {
                                            return;
                                        }

                                        const companyData = companies[choice.id];
                                        if (!companyData) {
                                            return;
                                        }

                                        setParty(companyData);
                                        setUsingLocalData(true);
                                        setMultipleChoicesName([]);
                                    }}
                                    inputProps={{
                                        placeholder: companyPlaceholder.name,
                                    }}
                                />
                            </div>
                        );
                    }

                    if (!editing && !expanded && field !== 'vatNumber') {
                        return null;
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
                                inputProps={{
                                    placeholder: (companyPlaceholder as any)[field] || '',
                                }}
                            />
                        </div>
                    );
                })}
            </div>

            {!editing && (
                <LinkButton
                    text={expanded ? collapseIcon : expandIcon}
                    onClick={() => {
                        const expander = kind === 'seller'
                            ? toggleExpandedSeller
                            : toggleExpandedBuyer;

                        expander();
                    }}
                />
            )}
        </div>
    );
    // #endregion render
}
