import {
    useState,
} from 'react';

import {
    Invoice,
} from '@/data';

import Subtitle from '@/components/Subtitle';
import InvoiceItem from '@/components/InvoiceItem';
import MenuBack from '@/components/MenuBack';
import PureButton from '@/components/PureButton';
import Deleter from '@/components/Deleter';

import {
    seriesParser,
} from '@/logic/series';

import useStore, {
    useVolatileStore,
} from '@/store';

import {
    generateEinvoice,
} from '@/logic/einvoice';



export default function EditInvoice({
    back,
} : {
    back: () => void;
}) {
    const {
        invoices,
        addInvoice,
        removeInvoice,
        lastInvoiceSeries,
        setLastInvoiceSeries,

        generateEinvoiceLocally,
    } = useStore();

    const {
        editID,
        setMenuView,
        setShowLoading,
    } = useVolatileStore();

    const [
        invoiceItem,
        setInvoiceItem,
    ] = useState<Invoice | null>(
        invoices[editID] || null,
    );


    if (!invoiceItem) {
        return (
            <div>
                <div>
                    factura nu a fost găsită
                </div>

                <MenuBack
                    back={back}
                />
            </div>
        );
    }

    return (
        <div
            className="scrollable-view overflow-auto h-screen w-full p-2"
        >
            <div
                className="w-full px-2 md:px-0 m-auto"
            >
                <Subtitle
                    text="editare factură"
                    centered={true}
                />

                <InvoiceItem
                    data={invoiceItem}
                    updateSeller={(data) => {
                        setInvoiceItem({
                            ...invoiceItem,
                            seller: data,
                        });
                    }}
                    updateBuyer={(data) => {
                        setInvoiceItem({
                            ...invoiceItem,
                            buyer: data,
                        });
                    }}
                    updateMetadata={(key, value) => {
                        setInvoiceItem({
                            ...invoiceItem,
                            metadata: {
                                ...invoiceItem.metadata,
                                [key]: value,
                            },
                        });
                    }}
                    updateDate={(key, value) => {
                        setInvoiceItem({
                            ...invoiceItem,
                            metadata: {
                                ...invoiceItem.metadata,
                                [key]: value,
                            },
                        });
                    }}
                    updateProducts={(data) => {
                        setInvoiceItem({
                            ...invoiceItem,
                            products: data,
                        });
                    }}
                    generateEinvoice={(
                        setLoadingEInvoice,
                    ) => {
                        generateEinvoice(
                            setLoadingEInvoice,
                            setShowLoading,
                            invoiceItem,
                            generateEinvoiceLocally,
                        );
                    }}
                />

                <PureButton
                    text="salvare"
                    atClick={() => {
                        addInvoice(invoiceItem);
                        setMenuView('invoices');
                    }}
                />

                <div
                    className="h-8"
                />

                <Deleter
                    title="ștergere"
                    atDelete={() => {
                        const seriesData = seriesParser(invoiceItem.metadata.number);
                        if (seriesData && lastInvoiceSeries === invoiceItem.metadata.number) {
                            setLastInvoiceSeries(seriesData.previousSeries);
                        }

                        removeInvoice(invoiceItem.id);
                        setMenuView('invoices');
                    }}
                />

                <MenuBack
                    back={() => {
                        setMenuView('invoices');
                    }}
                />
            </div>
        </div>
    );
}
