import {
    InvoiceLine,
} from '@/data';

import {
    financial,
} from '@/logic/utilities';



export const computeAllowance = (
    line: InvoiceLine,
) => {
    if (!line.allowance) {
        return 0;
    }

    if (line.allowance.fixedAmount) {
        return line.allowance.amount || 0;
    }

    return financial(line.price * line.quantity * (line.allowance.amount || 0) / 100);
}
