export type InvoiceLine = {
    name: string;
    price: number;
    vatRate: number;
    vatIncluded: boolean;
    quantity: number;
}


export interface Metadata {
    number: string;
    currency: string;
    issueDate: number;
    dueDate: number;
}


export type ResponseData = {
    status: boolean;
    data?: any;
}


export type ExtractedResponse = {
    status: false;
} | {
    status: true;
    data: {
        addressBuyer: string | null;
        addressSeller: string | null;
        cityBuyer: string | null;
        citySeller: string | null;
        countryBuyer: string | null;
        countrySeller: string | null;
        countyBuyer: string | null;
        countySeller: string | null;
        currency: string | null;
        issueDate: string | null;
        dueDate: string | null;
        invoiceNumber: string | null;
        nameBuyer: string | null;
        nameSeller: string | null;
        products: {
            description: string | null;
            price: number | null;
            quantity: number | null;
            total: number | null;
            unit: string | null;
            vat: number | null;
        }[];
        vatNumberBuyer: string | null;
        vatNumberSeller: string | null;
    };
}


export interface User {
    email: string;
    name: string;
    picture: string;
    intelligentActs: number;
}


export interface Company {
    vatNumber: string;
    name: string;
    address: string;
    city: string;
    county: string;
    country: string;
    contact?: string;
    IBAN?: string;
}


export interface Inventory {
    id: string;
    belongsTo: string;
    name: string;
    price: number;
    leftInStock: number;
    unit: string;
    currency: string;
    vatRate: number;
    vatIncluded: boolean;
    history: InventoryHistory[];
}

export interface InventoryHistory {
    id: string;
    date: number;
    supplier: string;
    invoice: string;
    acquisitionPrice: number;
    quantity: number;
    vatIncluded: boolean;
}


export interface Invoice {
    id: string;
    seller: Company;
    buyer: Company;
    metadata: Metadata;
    products: InvoiceLine[];
}
