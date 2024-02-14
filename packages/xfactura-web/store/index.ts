import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Required for zustand.
import type { } from '@redux-devtools/extension';

import {
    User,
    Company,
    Invoice,
    Inventory,
} from '@/data';

import useVolatileStore from './volatileStore';

import {
    normalizeVatNumber,
    verifyPartyData,
} from '@/logic/validation';



export interface State {
    user: User | null;
    setUser: (user: User | null) => void;
    usingLocalStorage: boolean;
    toggleUsingLocalStorage: () => void;
    generateEinvoiceLocally: boolean;
    toggleGenerateEinvoiceLocally: () => void;
    lastInvoiceSeries: string;
    setLastInvoiceSeries: (series: string) => void;
    smartActs: string;
    setSmartActs: (smartActs: string) => void;
    defaultSeller: string;
    setDefaultSeller: (defaultSeller: string) => void;
    storeGoogleDrive: boolean;
    toggleStoreGoogleDrive: () => void;

    companies: Record<string, Company>;
    addCompany: (company: Company) => void;
    editCompany: (company: Company) => void;
    removeCompany: (id: string) => void;

    invoices: Record<string, Invoice>;
    addInvoice: (invoice: Invoice) => void;
    removeInvoice: (id: string) => void;

    inventory: Record<string, Inventory>;
    addInventory: (inventory: Inventory) => void;
    removeInventory: (id: string) => void;

    loadData: (data: {
        companies: Record<string, Company>;
        invoices: Record<string, Invoice>;
        inventory: Record<string, Inventory>;
    }) => void;
    clearStore: () => void;

    intelligentActs: (data: any) => void;
}


const useStore = create<State>()(
    devtools(
    persist(
    immer(
        (set) => ({
            user: null,
            setUser: (user: User | null) => set({ user }),
            usingLocalStorage: true,
            toggleUsingLocalStorage: () => set((state) => ({ usingLocalStorage: !state.usingLocalStorage })),
            generateEinvoiceLocally: false,
            toggleGenerateEinvoiceLocally: () => set((state) => ({ generateEinvoiceLocally: !state.generateEinvoiceLocally })),
            lastInvoiceSeries: '',
            setLastInvoiceSeries: (series: string) => set({ lastInvoiceSeries: series }),
            smartActs: 'unspecified',
            setSmartActs: (smartActs: string) => set({ smartActs }),
            defaultSeller: '',
            setDefaultSeller: (defaultSeller: string) => set({ defaultSeller }),
            storeGoogleDrive: false,
            toggleStoreGoogleDrive: () => set((state) => ({ storeGoogleDrive: !state.storeGoogleDrive })),

            companies: {},
            addCompany: (company: Company) => set((state) => {
                const validData = verifyPartyData(company);
                if (!validData) {
                    return;
                }
                const vatNumber = normalizeVatNumber(company.vatNumber);
                if (state.companies[vatNumber]) {
                    return;
                }

                return {
                    companies: {
                        ...state.companies,
                        [company.vatNumber]: {
                            ...company,
                        },
                    },
                };
            }),
            editCompany: (company: Company) => set((state) => {
                const validData = verifyPartyData(company);
                if (!validData) {
                    return;
                }
                const vatNumber = normalizeVatNumber(company.vatNumber);
                if (!state.companies[vatNumber]) {
                    return;
                }

                return {
                    companies: {
                        ...state.companies,
                        [company.vatNumber]: {
                            ...company,
                        },
                    },
                };
            }),
            removeCompany: (id: string) => set((state) => {
                const companies = { ...state.companies };
                delete companies[id];

                const defaultSeller = state.defaultSeller === id ? '' : state.defaultSeller;

                return {
                    companies,
                    defaultSeller,
                };
            }),

            invoices: {},
            addInvoice: (invoice: Record<string, any>) => set((state) => ({
                invoices: {
                    ...state.invoices,
                    [invoice.id]: {
                        ...invoice,
                    },
                },
            })),
            removeInvoice: (id: string) => set((state) => {
                const invoices = { ...state.invoices };
                delete invoices[id];

                return {
                    invoices,
                };
            }),

            inventory: {},
            addInventory: (inventory: Record<string, any>) => set((state) => ({
                inventory: {
                    ...state.inventory,
                    [inventory.id]: {
                        ...inventory,
                    },
                },
            })),
            removeInventory: (id: string) => set((state) => {
                const inventory = { ...state.inventory };
                delete inventory[id];

                return {
                    inventory,
                };
            }),

            loadData: (data) => set(() => ({
                companies: data.companies,
                invoices: data.invoices,
                inventory: data.inventory,
            })),
            clearStore: () => set(() => ({
                user: null,
                usingLocalStorage: false,
                generateEinvoiceLocally: false,
                lastInvoiceSeries: '',
                smartActs: 'unspecified',
                defaultSeller: '',
                storeGoogleDrive: false,
                companies: {},
                invoices: {},
                inventory: {},
            })),

            intelligentActs: (data) => set(() => {
                const store = useStore.getState();
                const volatileStore = useVolatileStore.getState();
                // ACT
            }),
        }),
    ),
        {
            name: 'ZXFCT',
        },
    ),
    ),
);


export default useStore;

export {
    useVolatileStore,
};
