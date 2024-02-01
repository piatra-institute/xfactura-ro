import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { } from '@redux-devtools/extension';

import {
    User,
    NewParty,
    Invoice,
    Inventory,
} from '@/data';



export interface State {
    user: User | null;
    setUser: (user: User) => void;
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

    companies: Record<string, NewParty>;
    addCompany: (company: NewParty) => void;
    removeCompany: (id: string) => void;

    invoices: Record<string, Invoice>;
    addInvoice: (invoice: Invoice) => void;
    removeInvoice: (id: string) => void;

    inventory: Record<string, Inventory>;
    addInventory: (inventory: Inventory) => void;
    removeInventory: (id: string) => void;

    loadData: (data: {
        companies: Record<string, any>;
        invoices: Record<string, any>;
        inventory: Record<string, any>;
    }) => void;
    obliterate: () => void;
}

const useStore = create<State>()(
    devtools(
        persist(
            (set) => ({
                user: null,
                setUser: (user: User) => set({ user }),
                usingLocalStorage: false,
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
                addCompany: (company: NewParty) => set((state) => ({
                    companies: {
                        ...state.companies,
                        [company.vatNumber]: company,
                    },
                })),
                removeCompany: (id: string) => set((state) => {
                    const companies = { ...state.companies };
                    delete companies[id];

                    return {
                        companies,
                    };
                }),

                invoices: {},
                addInvoice: (invoice: Record<string, any>) => set((state) => ({
                    invoices: {
                        ...state.invoices,
                        [invoice.id]: invoice,
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
                        [inventory.id]: inventory,
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
                obliterate: () => set(() => ({
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
            }),
            {
                name: 'xfct-storage',
            },
        ),
    ),
);


export default useStore;
