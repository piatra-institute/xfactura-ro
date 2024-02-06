import {
    normalizeUserCountry,
    normalizeUserCounty,
    normalizeUserCity,
    normalizeVatNumber,
} from '@/logic/validation';

import {
    downloadTextFile,
    getDateFormat,
} from '@/logic/utilities';

import webContainerRunner from '@/logic/node-php';

import {
    getEInvoice,
} from '@/logic/requests';



export const generateEinvoice = async (
    setLoadingEInvoice: (value: boolean) => void,
    newInvoice: any,
    generateEinvoiceLocally: boolean,
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

    return invoice;
}
