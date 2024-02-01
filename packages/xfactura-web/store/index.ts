import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { } from '@redux-devtools/extension';



export interface State {
    user: {
        email: string;
        name: string;
        picture: string;
    } | null;
    generateEinvoiceLocally: boolean;
    toggleGenerateEinvoiceLocally: () => void;
    lastInvoiceSeries: string;
    setLastInvoiceSeries: (series: string) => void;
    smartActs: string;
    setSmartActs: (smartActs: string) => void;
    defaultSeller: string;
    setDefaultSeller: (defaultSeller: string) => void;
    companies: Record<string, any>;
    invoices: Record<string, any>;
    inventory: Record<string, any>;
}

const useStore = create<State>()(
    devtools(
        persist(
            (set) => ({
                user: null,
                generateEinvoiceLocally: false,
                toggleGenerateEinvoiceLocally: () => set((state) => ({ generateEinvoiceLocally: !state.generateEinvoiceLocally })),
                lastInvoiceSeries: '',
                setLastInvoiceSeries: (series: string) => set({ lastInvoiceSeries: series }),
                smartActs: 'unspecified',
                setSmartActs: (smartActs: string) => set({ smartActs }),
                defaultSeller: '',
                setDefaultSeller: (defaultSeller: string) => set({ defaultSeller }),
                companies: {},
                invoices: {},
                inventory: {},
            }),
            {
                name: 'xfct-storage',
            },
        ),
    ),
);


export default useStore;
