'use client';

import {
    useRef,
    useEffect,
} from 'react';

import { v4 as uuid } from 'uuid';

import {
    company,
    emptyInvoiceLine,
    emptyMetadata,
    Metadata as IMetadata,
} from '@/data';

import Deleter from '@/components/Deleter';
import InvoiceItem from '@/components/InvoiceItem';

import {
    generateEinvoice,
} from '@/logic/einvoice';

import {
    seriesParser,
} from '@/logic/series';

import useStore, {
    useVolatileStore,
} from '@/store';



export default function Invoice() {
    // #region references
    const metadataNumberSet = useRef(false);
    // #endregion references


    // #region state
    const {
        generateEinvoiceLocally,

        lastInvoiceSeries,
        setLastInvoiceSeries,

        addInvoice,
        addCompany,
    } = useStore();

    const {
        newInvoice,
        setNewInvoiceSeller,
        setNewInvoiceBuyer,
        setNewInvoiceMetadata,
        setNewInvoiceLines,

        setShowLoading,
    } = useVolatileStore();
    // #endregion state


    // #region handlers
    const updateMetadata = (
        type: keyof IMetadata,
        value: string | number,
    ) => {
        setNewInvoiceMetadata({
            ...newInvoice.metadata,
            [type]: value,
        });
    }

    const updateDate = (
        kind: 'issueDate' | 'dueDate',
        timestamp: number,
    ) => {
        updateMetadata(kind, timestamp);
    }

    const handleGenerateEinvoice = async (
        setLoadingEInvoice: (value: boolean) => void,
    ) => {
        await generateEinvoice(
            setLoadingEInvoice,
            setShowLoading,
            newInvoice,
            generateEinvoiceLocally,
        );

        addInvoice({
            id: uuid(),
            seller: newInvoice.seller,
            buyer: newInvoice.buyer,
            metadata: newInvoice.metadata,
            products: newInvoice.products,
        });

        setLastInvoiceSeries(newInvoice.metadata.number);

        addCompany(newInvoice.seller);
        addCompany(newInvoice.buyer);
    }

    const resetInvoice = () => {
        if (!newInvoice.seller.vatNumber) {
            setNewInvoiceSeller({
                ...company,
            });
        }

        setNewInvoiceBuyer({
            ...company,
        });

        const seriesData = seriesParser(lastInvoiceSeries);
        if (seriesData) {
            setNewInvoiceMetadata({
                ...newInvoice.metadata,
                number: seriesData.nextSeries,
            });
        } else {
            setNewInvoiceMetadata({
                ...emptyMetadata,
            });
        }

        setNewInvoiceLines([{
            ...emptyInvoiceLine,
        }]);
    }
    // #endregion handlers


    // #region effects
    /** series */
    useEffect(() => {
        const seriesData = seriesParser(lastInvoiceSeries);
        if (!seriesData) {
            return;
        }

        if (metadataNumberSet.current) {
            // Do not update after einvoice generation.
            return;
        }

        setNewInvoiceMetadata({
            ...newInvoice.metadata,
            number: seriesData.nextSeries,
        });
        metadataNumberSet.current = true;

        // Run only once.
        // eslint-disable-next-line
    }, [
        lastInvoiceSeries,
    ]);
    // #endregion effects


    // #region render
    return (
        <>
            <InvoiceItem
                data={newInvoice}
                updateSeller={setNewInvoiceSeller}
                updateBuyer={setNewInvoiceBuyer}
                updateMetadata={updateMetadata}
                updateDate={updateDate}
                updateProducts={setNewInvoiceLines}
                generateEinvoice={handleGenerateEinvoice}
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
                className="mb-4 md:mb-8"
            />
        </>
    );
    // #endregion render
}
