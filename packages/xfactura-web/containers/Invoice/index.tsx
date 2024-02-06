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

import webContainerRunner from '@/logic/node-php';

import {
    downloadTextFile,
    getDateFormat,
} from '@/logic/utilities';

import {
    normalizeUserCountry,
    normalizeUserCounty,
    normalizeUserCity,
    normalizeVatNumber,
} from '@/logic/validation';

import {
    getEInvoice,
} from '@/logic/requests';

import {
    seriesParser,
} from '@/logic/series';

import useStore from '@/store';



export default function Home() {
    // #region state
    const {
        newInvoice,
        setNewInvoiceSeller,
        setNewInvoiceBuyer,
        setNewInvoiceMetadata,
        setNewInvoiceLines,

        generateEinvoiceLocally,

        lastInvoiceSeries,
        setLastInvoiceSeries,

        addInvoice,
    } = useStore();
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

    const generateEinvoice = async (
        setLoadingEInvoice: (value: boolean) => void,
    ) => {
        setLoadingEInvoice(true);

        const invoice = {
            metadata: {
                ...newInvoice.metadata,
                issueDate: getDateFormat(newInvoice.metadata.issueDate),
                dueDate: getDateFormat(newInvoice.metadata.dueDate),
            },
            seller: {
                ...newInvoice.seller,
                vatNumber: normalizeVatNumber(newInvoice.seller.vatNumber),
                country: normalizeUserCountry(newInvoice.seller.country),
                subdivision: normalizeUserCounty(newInvoice.seller.county, newInvoice.seller.country),
                city: normalizeUserCity(newInvoice.seller.city, newInvoice.seller.county),
            },
            buyer: {
                ...newInvoice.buyer,
                vatNumber: normalizeVatNumber(newInvoice.buyer.vatNumber),
                country: normalizeUserCountry(newInvoice.buyer.country),
                subdivision: normalizeUserCounty(newInvoice.buyer.county, newInvoice.buyer.country),
                city: normalizeUserCity(newInvoice.buyer.city, newInvoice.buyer.county),
            },
            lines: [
                ...newInvoice.products,
            ],
        };

        addInvoice({
            id: uuid(),
            seller: invoice.seller,
            buyer: invoice.buyer,
            metadata: newInvoice.metadata,
            products: invoice.lines,
        });

        const filename = `efactura-${newInvoice.metadata.number}-${newInvoice.seller.name}-${newInvoice.buyer.name}.xml`;

        if (generateEinvoiceLocally) {
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

        setLastInvoiceSeries(invoice.metadata.number);
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
    }, []);
    // #endregion effects


    return (
        <>
            <InvoiceItem
                data={newInvoice}
                updateSeller={setNewInvoiceSeller}
                updateBuyer={setNewInvoiceBuyer}
                updateMetadata={setNewInvoiceMetadata}
                updateDate={updateDate}
                updateProducts={setNewInvoiceLines}
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
        </>
    );
}
