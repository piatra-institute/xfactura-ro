export interface Action {
    type:
        | 'setSellerVatNumber'
        | 'setSellerName'
        | 'setSellerCountry'
        | 'setSellerCounty'
        | 'setSellerCity'
        | 'setSellerAddress'
        | 'setBuyerVatNumber'
        | 'setBuyerName'
        | 'setBuyerCountry'
        | 'setBuyerCounty'
        | 'setBuyerCity'
        | 'setBuyerAddress'
        | 'setInvoiceNumber'
        | 'setCurrency'
        | 'setIssueDate'
        | 'setDueDate'
        | 'addProduct'
        ;
    payload: any;
}


export type AddProductPayload = {
    price: number;
    quantity: number;
    name: string;
};


export const applyActions = (
    actions: Action[],
    appliers: Record<string, (payload: any) => void>,
) => {
    for (const action of actions) {
        // appliers[action.type](action.payload);
    }
}
