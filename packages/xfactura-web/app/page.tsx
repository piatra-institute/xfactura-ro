'use client';

import {
    useRef,
    useEffect,
} from 'react';

import {
    emptyInvoiceLine,
    ExtractedResponse,
} from '@/data';

import Menu from '@/components/Menu';
import Spinner from '@/components/Spinner';

import Title from '@/containers/Title';
import Extractors from '@/containers/Extractors';
import Text from '@/containers/Text';
import Camera from '@/containers/Camera';
import Audio from '@/containers/Audio';

import Invoice from '@/containers/Invoice';

import webContainerRunner from '@/logic/node-php';

import {
    verifyInputVatNumber,
    verifyInputUserName,
    verifyInputUserCountry,
    verifyInputUserCounty,
    verifyInputUserCity,
    verifyInputUserAddress,
    verifyInputUserInvoiceNumber,
    verifyInputUserCurrency,
    verifyInputUserDate,
} from '@/logic/validation';

import {
    uploadFile,
    uploadAudio,
    uploadText,
} from '@/logic/requests';

import {
    logicCamera,
} from '@/logic/camera';

import {
    getUser,
} from '@/logic/requests';

import useStore, {
    useVolatileStore,
} from '@/store';



export default function Home() {
    // #region references
    const mounted = useRef(false);
    // #endregion references


    // #region state
    const {
        setUser,

        generateEinvoiceLocally,
    } = useStore();

    const {
        showLoading,
        setShowLoading,

        setHasMediaDevices,

        showText,
        showCamera,
        setShowCamera,
        showMicrophone,

        newInvoice,
        setNewInvoiceSeller,
        setNewInvoiceBuyer,
        setNewInvoiceMetadata,
        setNewInvoiceLines,
    } = useVolatileStore();
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

    const extractInvoiceFromText = async (
        text: string,
    ) => {
        setShowLoading(true);
        const response = await uploadText(text);
        setShowLoading(false);
        handleExtractedData(response);
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

            setNewInvoiceSeller({
                vatNumber: verifyInputVatNumber(vatNumberSeller) || newInvoice.seller.vatNumber,
                name: verifyInputUserName(nameSeller) || newInvoice.seller.name,
                country: verifyInputUserCountry(countrySeller) || newInvoice.seller.country,
                county: verifyInputUserCounty(countySeller) || newInvoice.seller.county,
                city: verifyInputUserCity(citySeller) || newInvoice.seller.city,
                address: verifyInputUserAddress(addressSeller) || newInvoice.seller.address,
            });

            setNewInvoiceBuyer({
                vatNumber: verifyInputVatNumber(vatNumberBuyer) || newInvoice.buyer.vatNumber,
                name: verifyInputUserName(nameBuyer) || newInvoice.buyer.name,
                country: verifyInputUserCountry(countryBuyer) || newInvoice.buyer.country,
                county: verifyInputUserCounty(countyBuyer) || newInvoice.buyer.county,
                city: verifyInputUserCity(cityBuyer) || newInvoice.buyer.city,
                address: verifyInputUserAddress(addressBuyer) || newInvoice.buyer.address,
            });

            setNewInvoiceMetadata({
                number: verifyInputUserInvoiceNumber(invoiceNumber) || newInvoice.metadata.number,
                currency: verifyInputUserCurrency(currency) || newInvoice.metadata.currency,
                issueDate: verifyInputUserDate(issueDate) || newInvoice.metadata.issueDate,
                dueDate: verifyInputUserDate(dueDate) || newInvoice.metadata.dueDate,
            });

            if (Array.isArray(products)) {
                const newLines = [
                    ...newInvoice.products,
                    ...products.map((product) => ({
                        ...emptyInvoiceLine,
                        name: product.description || '',
                        quantity: product.quantity || 1,
                        price: product.price || 0,
                        vatRate: product.vat || 19,
                    })),
                ].filter(line => line.name !== '');

                setNewInvoiceLines([
                    ...newLines,
                ]);
            }
        } catch (error) {
            return;
        }
    }
    // #endregion handlers


    // #region effects
    useEffect(() => {
        const loadUser = async () => {
            const request = await getUser();
            if (!request || !request.status) {
                setUser(null);
                return;
            }

            setUser(request.data);
        }

        loadUser();
    }, [
        setUser,
    ]);

    /** web container */
    useEffect(() => {
        if (mounted.current) {
            return;
        }
        mounted.current = true;

        if (generateEinvoiceLocally) {
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

        // Let effect run only once.
        // eslint-disable-next-line
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

        // Let effect run only once.
        // eslint-disable-next-line
    }, []);

    useEffect(() => {
        if (newInvoice.buyer.name === ''
            || newInvoice.products.every((product) => product.name === '')
        ) {
            return;
        }

        const beforeUnloadHandler = (event: Event) => {
            // Recommended
            event.preventDefault();
            // Included for legacy support, e.g. Chrome/Edge < 119
            event.returnValue = true;
        };

        window.addEventListener('beforeunload', beforeUnloadHandler);

        return () => {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
        }
    }, [
        newInvoice.buyer.name,
        newInvoice.products,
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
                        extractInvoiceFromFile={extractInvoiceFromFile}
                    />

                    {showText && (
                        <Text
                            extractInvoiceFromText={extractInvoiceFromText}
                        />
                    )}

                    {showCamera && (
                        <Camera
                            extractInvoiceFromCamera={extractInvoiceFromCamera}
                        />
                    )}

                    {showMicrophone && (
                        <Audio
                            extractInvoiceFromAudio={extractInvoiceFromAudio}
                        />
                    )}
                </div>

                <Invoice />
            </div>
        </>
    );
}
