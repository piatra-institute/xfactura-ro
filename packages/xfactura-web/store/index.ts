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
    smartActs: string;
    defaultSeller: string;
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
                smartActs: 'unspecified',
                defaultSeller: '',
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
