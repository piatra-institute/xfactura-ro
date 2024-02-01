import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { } from '@redux-devtools/extension';



export interface State {
    user: {
        email: string;
        name: string;
        picture: string;
    } | null;
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
    companies: Record<string, any>;
    invoices: Record<string, any>;
    inventory: Record<string, any>;

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
                invoices: {},
                inventory: {},

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
