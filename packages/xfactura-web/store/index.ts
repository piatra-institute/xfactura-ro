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
    Metadata,
    InvoiceLine,

    company,
    emptyInvoiceLine,
    emptyMetadata,
} from '@/data';

import volatileStore from './volatileStore';



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
    obliterate: () => void;

    showLoading: boolean;
    setShowLoading: (loading: boolean) => void;

    hasMediaDevices: boolean;
    setHasMediaDevices: (hasMediaDevices: boolean) => void;

    showCamera: boolean;
    setShowCamera: (showCamera: boolean) => void;

    showMicrophone: boolean;
    setShowMicrophone: (showMicrophone: boolean) => void;

    newInvoice: Invoice;
    setNewInvoiceSeller: (seller: Company) => void;
    setNewInvoiceBuyer: (seller: Company) => void;
    setNewInvoiceMetadata: (metadata: Metadata) => void;
    setNewInvoiceLines: (lines: InvoiceLine[]) => void;
}


const useStore = create<State>()(
    devtools(
    persist(
    immer(
        (set) => ({
            user: null,
            setUser: (user: User | null) => set({ user }),
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
            addCompany: (company: Company) => set((state) => ({
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

            showLoading: false,
            setShowLoading: (showLoading: boolean) => set({ showLoading }),

            hasMediaDevices: true,
            setHasMediaDevices: (hasMediaDevices: boolean) => set({ hasMediaDevices }),

            showCamera: false,
            setShowCamera: (showCamera: boolean) => set({ showCamera }),

            showMicrophone: false,
            setShowMicrophone: (showMicrophone: boolean) => set({ showMicrophone }),

            newInvoice: {
                id: '',
                seller: {...company},
                buyer: {...company},
                metadata: {...emptyMetadata},
                products: [
                    {...emptyInvoiceLine},
                ],
            },
            setNewInvoiceSeller: (seller: Company) => set((state) => {
                state.newInvoice.seller = seller;
            }),
            setNewInvoiceBuyer: (buyer: Company) => set((state) => {
                state.newInvoice.buyer = buyer;
            }),
            setNewInvoiceMetadata: (metadata: Metadata) => set((state) => {
                state.newInvoice.metadata = metadata;
            }),
            setNewInvoiceLines: (lines: InvoiceLine[]) => set((state) => {
                state.newInvoice.products = lines;
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
    volatileStore,
};
