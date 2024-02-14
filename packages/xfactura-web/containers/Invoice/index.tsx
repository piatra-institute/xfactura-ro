'use client';

import {
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



export default function Home() {
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
        const invoice = await generateEinvoice(
            setLoadingEInvoice,
            newInvoice,
            generateEinvoiceLocally,
        );

        addInvoice({
            id: uuid(),
            seller: invoice.seller,
            buyer: invoice.buyer,
            metadata: newInvoice.metadata,
            products: invoice.lines,
        });

        setLastInvoiceSeries(invoice.metadata.number);

        addCompany(invoice.seller);
        addCompany(invoice.buyer);
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

        setNewInvoiceMetadata({
            ...newInvoice.metadata,
            number: seriesData.nextSeries,
        });

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
                className="mb-8"
            />
        </>
    );
    // #endregion render
}
