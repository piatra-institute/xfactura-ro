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
    countyMap,
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
import Toggle from '@/components/Toggle';

import {
    getCompanyDetails,
} from '@/logic/requests';

import fuzzySearch, {
    companySearcher,
    countySearcher,
    citySearcher,
    cityDataFetcher,
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
    const titleRef = useRef<HTMLDivElement | null>(null);
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

    const [
        multipleChoicesCounty,
        setMultipleChoicesCounty,
    ] = useState<MultipleChoice[]>();

    const [
        multipleChoicesCity,
        setMultipleChoicesCity,
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
                    vatNumber: normalizeVatNumber(vatNumber, data.vatPayer),
                    name: name ? normalizePartyName(name) : data.name,
                    address: address ? address : data.address,
                    city: city ? normalizePartyCity(city) : data.city,
                    county: county ? normalizePartyCounty(county) : data.county,
                    country: 'România',
                });
            } else {
                setParty({
                    ...data,
                    vatNumber: normalizeVatNumber(vatNumber, data.vatPayer),
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

    useEffect(() => {
        if (data.county.length < 2) {
            setMultipleChoicesCounty([]);
            return;
        }

        const county = normalizeDiacritics(data.county.toLowerCase().trim());

        countySearcher.indexEntities(
            Object.keys(countyMap),
            (entity) => entity,
            (entity) => [entity],
        );
        const result = countySearcher.getMatches(new fuzzySearch.Query(
            county,
            10,
            0.2,
        ));
        if (
            result.matches.length === 0
            || result.matches.some(match => match.quality === 1)
        ) {
            setMultipleChoicesCounty([]);
            return;
        }

        const choices = result.matches.map((match) => {
            return {
                id: match.entity,
                name: match.entity,
            };
        });

        if (choices.length === 1 && choices[0].name === data.county) {
            setMultipleChoicesCounty([]);
            return;
        }

        setMultipleChoicesCounty(choices);
    }, [
        data.county,
    ]);

    useEffect(() => {
        if (!data.county || data.city.length < 2) {
            setMultipleChoicesCity([]);
            return;
        }

        const city = normalizeDiacritics(data.city.toLowerCase().trim());
        const cityData: string[] = cityDataFetcher.getByCounty(
            normalizeDiacritics(data.county.toLowerCase().trim()),
        );
        if (cityData.length === 0) {
            setMultipleChoicesCity([]);
            return;
        }

        citySearcher.indexEntities(
            cityData,
            (entity) => entity,
            (entity) => [entity],
        );
        const result = citySearcher.getMatches(new fuzzySearch.Query(
            city,
            10,
            0.2,
        ));
        if (
            result.matches.length === 0
            || result.matches.some(match => match.quality === 1)
        ) {
            setMultipleChoicesCity([]);
            return;
        }

        const choices = result.matches.map((match) => {
            return {
                id: match.entity,
                name: match.entity,
            };
        });

        if (choices.length === 1 && choices[0].name === data.city) {
            setMultipleChoicesCity([]);
            return;
        }

        setMultipleChoicesCity(choices);
    }, [
        data.county,
        data.city,
    ]);
    // #endregion effects


    // #region render
    const expanded = editing
        ? true
        : kind === 'seller'
            ? expandedSeller
            : expandedBuyer;

    return (
        <div
            className={styleless ? '' : 'md:w-1/2 min-h-[150px] p-2 md:p-8 md:max-w-[360px]'}
        >
            <div
                className="mb-4"
                ref={titleRef}
            />
            <Subtitle
                text={title}
            />

            <div
                className={styleless ? '' : 'min-w-[280px] flex flex-col justify-between md:block'}
            >
                <Input
                    text={companyText.vatNumber}
                    value={data.vatNumber}
                    setValue={updateParty('vatNumber')}
                    loading={loadingVatNumber}
                    inputProps={{
                        placeholder: data.vatPayer ? companyPlaceholder.vatNumber : companyPlaceholder.vatNumberNonPayer,
                    }}
                />

                <Input
                    text={companyText.name}
                    value={data.name}
                    setValue={updateParty('name')}
                    multipleChoiceFocusable={true}
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

                {expanded && (
                    <>
                        <Input
                            text={companyText.country}
                            value={data.country}
                            setValue={updateParty('country')}
                        />

                        <Input
                            text={companyText.county}
                            value={data.county}
                            setValue={updateParty('county')}
                            multipleChoices={multipleChoicesCounty}
                            multipleChoiceFocusable={true}
                            atChoice={(choice) => {
                                if (typeof choice === 'string') {
                                    return;
                                }

                                setParty({
                                    ...data,
                                    county: choice.name,
                                });
                                setMultipleChoicesCounty([]);
                            }}
                        />

                        <Input
                            text={companyText.city}
                            value={data.city}
                            setValue={updateParty('city')}
                            multipleChoices={multipleChoicesCity}
                            multipleChoiceFocusable={true}
                            atChoice={(choice) => {
                                if (typeof choice === 'string') {
                                    return;
                                }

                                setParty({
                                    ...data,
                                    city: choice.name,
                                });
                                setMultipleChoicesCity([]);
                            }}
                        />

                        <Input
                            text={companyText.address}
                            value={data.address}
                            setValue={updateParty('address')}
                            inputProps={{
                                placeholder: companyPlaceholder.address,
                            }}
                        />

                        <Input
                            text={companyText.contact}
                            value={data.contact}
                            setValue={updateParty('contact')}
                            inputProps={{
                                placeholder: companyPlaceholder.contact,
                            }}
                        />

                        <Input
                            text={companyText.IBAN}
                            value={data.IBAN}
                            setValue={updateParty('IBAN')}
                        />

                        <Toggle
                            text="plătitor de TVA"
                            value={data.vatPayer}
                            toggle={() => {
                                setParty({
                                    ...data,
                                    vatPayer: !data.vatPayer,
                                });
                            }}
                            style={{
                                margin: '1rem 0',
                            }}
                        />
                    </>
                )}
            </div>

            {!editing && (
                <LinkButton
                    text={expanded ? collapseIcon : expandIcon}
                    onClick={() => {
                        const expander = kind === 'seller'
                            ? toggleExpandedSeller
                            : toggleExpandedBuyer;

                        expander();

                        if (titleRef.current) {
                            titleRef.current.scrollIntoView({ behavior: 'smooth' });
                        }
                    }}
                />
            )}
        </div>
    );
    // #endregion render
}
