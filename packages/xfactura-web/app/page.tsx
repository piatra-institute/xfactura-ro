'use client';

import {
    useState,
    useRef,
    useEffect,
} from 'react';

import {
    newParty,
    NewParty,
    emptyInvoiceLine,
    InvoiceLine,
    emptyMetadata,
    Metadata as IMetadata,
    ExtractedResponse,
} from '../data';

import Menu from '../components/Menu';
import Party from '../components/Party';
import Lines from '../components/Lines';
import Spinner from '../components/Spinner';
import Deleter from '../components/Deleter';
import GenerateButton from '../components/GenerateButton';

import Title from '../containers/Title';
import Extractors from '../containers/Extractors';
import Metadata from '../containers/Metadata';
import Camera from '../containers/Camera';
import Audio from '../containers/Audio';

import webContainerRunner from '../logic/node-php';

import {
    downloadTextFile,
    getDateFormat,
} from '../logic/utilities';

import {
    checkValidParty,
    checkValidLine,
    checkValidMetadata,
    normalizeUserCounty,
    normalizeUserCountry,
    normalizeVatNumber,
    verifyInputVatNumber,
    verifyInputUserName,
    verifyInputUserCountry,
    verifyInputUserCounty,
    verifyInputUserCity,
    verifyInputUserAddress,
    verifyInputUserInvoiceNumber,
    verifyInputUserCurrency,
    verifyInputUserDate,
} from '../logic/validation';

import {
    getEInvoice,
    uploadFile,
    uploadAudio,
} from '../logic/requests';

import {
    logicCamera,
} from '../logic/camera';

import localStorage from '../data/localStorage';



export default function Home() {
    // #region references
    const mounted = useRef(false);
    // #endregion references


    // #region state
    const [
        showLoading,
        setShowLoading,
    ] = useState(true);

    const [
        hasMediaDevices,
        setHasMediaDevices,
    ] = useState(true);

    const [
        showCamera,
        setShowCamera,
    ] = useState(false);

    const [
        showMicrophone,
        setShowMicrophone,
    ] = useState(false);

    const [
        loadingEInvoice,
        setLoadingEInvoice,
    ] = useState(false);

    const [
        validData,
        setValidData,
    ] = useState(false);

    const [
        seller,
        setSeller,
    ] = useState<NewParty>({
        ...newParty,
    });

    const [
        buyer,
        setBuyer,
    ] = useState<NewParty>({
        ...newParty,
    });

    const [
        metadata,
        setMetadata,
    ] = useState<IMetadata>({
        ...emptyMetadata,
    });

    const [
        lines,
        setLines,
    ] = useState<InvoiceLine[]>([{
        ...emptyInvoiceLine,
    }]);
    // #endregion state


    // #region handlers
    const extractInvoiceFromFile = async (
        file: File,
    ) => {
        setShowLoading(true);
        const response = await uploadFile(file);
        handleExtractedData(response);
        setShowLoading(false);
    }

    const extractInvoiceFromCamera = async (
        dataURI: string,
    ) => {
        setShowCamera(false);

        setShowLoading(true);
        await logicCamera(dataURI, handleExtractedData);
        setShowLoading(false);
    }

    const extractInvoiceFromAudio = async (
        blob: Blob,
    ) => {
        setShowLoading(true);
        const response = await uploadAudio(blob);
        setShowLoading(false);
        handleExtractedData(response);
    }


    const updateMetadata = (
        type: keyof IMetadata,
        value: string | number,
    ) => {
        setMetadata(prevValues => ({
            ...prevValues,
            [type]: value,
        }));
    }

    const updateDate = (
        kind: 'issueDate' | 'dueDate',
        timestamp: number,
    ) => {
        updateMetadata(kind, timestamp);
    }

    const addNewLine = () => {
        setLines(prevValues => ([
            ...prevValues,
            emptyInvoiceLine,
        ]));
    }

    const generateEinvoice = async () => {
        setLoadingEInvoice(true);

        const invoice = {
            metadata: {
                ...metadata,
                issueDate: getDateFormat(metadata.issueDate),
                dueDate: getDateFormat(metadata.dueDate),
            },
            seller: {
                ...seller,
                vatNumber: normalizeVatNumber(seller.vatNumber),
                subdivision: normalizeUserCounty(seller.county, seller.country),
                country: normalizeUserCountry(seller.country),
            },
            buyer: {
                ...buyer,
                vatNumber: normalizeVatNumber(buyer.vatNumber),
                subdivision: normalizeUserCounty(buyer.county, buyer.country),
                country: normalizeUserCountry(buyer.country),
            },
            lines,
        };


        const filename = `efactura-${metadata.number}-${seller.name}-${buyer.name}.xml`;

        if (localStorage.generateEinvoiceLocally) {
            await webContainerRunner.writeData(invoice);
            await webContainerRunner.startNodePHPServer(
                (value) => {
                    setLoadingEInvoice(false);

                    downloadTextFile(
                        filename,
                        value,
                    );
                },
            );
        } else {
                const response = await getEInvoice(invoice);
                setLoadingEInvoice(false);

                if (response && response.status) {
                    downloadTextFile(
                        filename,
                        response.data,
                    );
                }

        }
    }

    const resetInvoice = () => {
        setSeller({
            ...newParty,
        });

        setBuyer({
            ...newParty,
        });

        setMetadata({
            ...emptyMetadata,
        });

        setLines([{
            ...emptyInvoiceLine,
        }]);
    }

    const handleExtractedData = (
        response: ExtractedResponse,
    ) => {
        try {
            if (!response || !response.status) {
                return;
            }

            const {
                vatNumberSeller,
                nameSeller,
                countrySeller,
                countySeller,
                citySeller,
                addressSeller,

                vatNumberBuyer,
                nameBuyer,
                countryBuyer,
                countyBuyer,
                cityBuyer,
                addressBuyer,

                invoiceNumber,
                currency,
                issueDate,
                dueDate,

                products,
            } = response.data;

            setSeller(prevValues => ({
                ...prevValues,
                vatNumber: verifyInputVatNumber(vatNumberSeller) || prevValues.vatNumber,
                name: verifyInputUserName(nameSeller) || prevValues.name,
                country: verifyInputUserCountry(countrySeller) || prevValues.country,
                county: verifyInputUserCounty(countySeller) || prevValues.county,
                city: verifyInputUserCity(citySeller) || prevValues.city,
                address: verifyInputUserAddress(addressSeller) || prevValues.address,
            }));

            setBuyer(prevValues => ({
                ...prevValues,
                vatNumber: verifyInputVatNumber(vatNumberBuyer) || prevValues.vatNumber,
                name: verifyInputUserName(nameBuyer) || prevValues.name,
                country: verifyInputUserCountry(countryBuyer) || prevValues.country,
                county: verifyInputUserCounty(countyBuyer) || prevValues.county,
                city: verifyInputUserCity(cityBuyer) || prevValues.city,
                address: verifyInputUserAddress(addressBuyer) || prevValues.address,
            }));

            setMetadata(prevValues => ({
                ...prevValues,
                number: verifyInputUserInvoiceNumber(invoiceNumber) || prevValues.number,
                currency: verifyInputUserCurrency(currency) || prevValues.currency,
                issueDate: verifyInputUserDate(issueDate) || prevValues.issueDate,
                dueDate: verifyInputUserDate(dueDate) || prevValues.dueDate,
            }));

            if (Array.isArray(products)) {
                const newLines = [
                    ...lines,
                    ...products.map((product) => ({
                        ...emptyInvoiceLine,
                        name: product.description || '',
                        quantity: product.quantity || 1,
                        price: product.price || 0,
                        vatRate: product.vat || 19,
                    })),
                ].filter(line => line.name !== '');

                setLines([
                    ...newLines,
                ]);
            }
        } catch (error) {
            return;
        }
    }
    // #endregion handlers


    // #region effects
    /** web container */
    useEffect(() => {
        if (mounted.current) {
            return;
        }
        mounted.current = true;

        if (localStorage.generateEinvoiceLocally) {
            webContainerRunner.load()
                .then((loaded) => {
                    setShowLoading(false);

                    if (!loaded) {
                        // TODO
                        // notify error
                    }
                });
        } else {
            setShowLoading(false);
        }
    }, []);

    /** media devices */
    useEffect(() => {
        let hasMediaDevices = true;

        if ('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices) {
            hasMediaDevices = true;
        } else {
            hasMediaDevices = false;
        }

        setHasMediaDevices(hasMediaDevices);
    }, []);

    /** valid data */
    useEffect(() => {
        const validSeller = checkValidParty(seller);
        const validBuyer = checkValidParty(buyer);
        const validMetadata = checkValidMetadata(metadata);
        const validLines = lines.every(checkValidLine);

        const validData = (
            validSeller &&
            validBuyer &&
            validMetadata &&
            validLines
        );

        setValidData(validData);
    }, [
        seller,
        buyer,
        metadata,
        lines,
    ]);
    // #endregion effects


    return (
        <>
            {showLoading && (
                <Spinner />
            )}

            <Menu />

            <div>
                <div
                    className="m-4 pb-4"
                >
                    <Title />

                    <Extractors
                        hasMediaDevices={hasMediaDevices}
                        setShowCamera={setShowCamera}
                        setShowMicrophone={setShowMicrophone}
                        extractInvoiceFromFile={extractInvoiceFromFile}
                    />

                    {showCamera && (
                        <Camera
                            extractInvoiceFromCamera={extractInvoiceFromCamera}
                            back={() => setShowCamera(false)}
                        />
                    )}

                    {showMicrophone && (
                        <Audio
                            setShowMicrophone={setShowMicrophone}
                            extractInvoiceFromAudio={extractInvoiceFromAudio}
                            hide={() => setShowMicrophone(false)}
                        />
                    )}
                </div>

                <div
                    className="grid items-center justify-center md:flex m-auto"
                >
                    <Party
                        kind="seller"
                        title="furnizor"
                        data={seller}
                        setParty={setSeller}
                    />

                    <Party
                        kind="buyer"
                        title="cumpărător"
                        data={buyer}
                        setParty={setBuyer}
                    />
                </div>

                <Metadata
                    metadata={metadata}
                    updateMetadata={updateMetadata}
                    updateDate={updateDate}
                />

                <Lines
                    data={lines}
                    setLines={setLines}
                    addNewLine={addNewLine}
                    currency={metadata.currency}
                />

                <GenerateButton
                    loadingEInvoice={loadingEInvoice}
                    validData={validData}
                    generateEinvoice={generateEinvoice}
                />

                <div
                    className="grid place-content-center p-8"
                >
                    <Deleter
                        title="xfactură nouă"
                        atDelete={() => resetInvoice()}
                    />
                </div>

                <div
                    className="mb-8"
                />
            </div>
        </>
    );
}
