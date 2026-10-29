import {
    calculateInvoice,
    checkInvoice,
    fromInvoicer,
    invoicerAmounts,
    writeInvoice,
} from 'xfactura-core/einvoice';

import {
    Invoice,
} from '@/data';

import {
    downloadTextFile,
} from '@/logic/utilities';



/**
 * Writes the e-Factura XML in the browser, so the invoice never leaves the device. Throws an
 * error with a Romanian message when the invoice cannot be a valid e-Factura.
 */
export const generateEinvoice = async (
    setLoadingEInvoice: (value: boolean) => void,
    setShowLoading: (value: boolean) => void,
    newInvoice: Invoice,
) => {
    setShowLoading(true);
    setLoadingEInvoice(true);

    try {
        const invoice = calculateInvoice(fromInvoicer(newInvoice).draft);
        const [problem] = checkInvoice(invoice);
        if (problem) {
            throw new Error(problem.message);
        }

        downloadTextFile(
            `efactura-${newInvoice.metadata.number}-${newInvoice.seller.name}-${newInvoice.buyer.name}.xml`,
            writeInvoice(invoice),
        );

        return invoice;
    } finally {
        setLoadingEInvoice(false);
        setShowLoading(false);
    }
}


/** The amount payable, computed exactly as on the e-Factura; NaN while a line is incomplete. */
export const invoiceTotal = (
    invoice: Invoice,
) => {
    try {
        return Number(invoicerAmounts(invoice.products).totals.payable);
    } catch {
        return NaN;
    }
}
