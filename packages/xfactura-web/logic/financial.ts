import {
    invoicerAmounts,
} from 'xfactura-core/einvoice';

import {
    InvoiceLine,
} from '@/data';



/** The line allowance in currency, computed exactly as on the e-Factura. */
export const computeAllowance = (
    line: InvoiceLine,
) => {
    if (!line.allowance) {
        return 0;
    }

    try {
        return Number(invoicerAmounts([line]).lines[0]?.adjustments[0]?.amount ?? 0);
    } catch {
        return 0;
    }
}
