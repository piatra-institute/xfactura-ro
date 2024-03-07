import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Required for zustand.
import type { } from '@redux-devtools/extension';

import {
    Company,
    Invoice,
    Metadata,
    InvoiceLine,

    company,
    emptyInvoiceLine,
    emptyMetadata,
} from '@/data';



export type MenuView =
    | 'general' | 'about' | 'ai'
    | 'companies' | 'edit-company'
    | 'inventory' | 'edit-inventory'
    | 'invoices' | 'edit-invoice'
    | 'settings';


export interface VolatileState {
    showLoading: boolean;
    setShowLoading: (loading: boolean) => void;

    hasMediaDevices: boolean;
    setHasMediaDevices: (hasMediaDevices: boolean) => void;

    showText: boolean;
    setShowText: (showText: boolean) => void;

    showCamera: boolean;
    setShowCamera: (showCamera: boolean) => void;

    showMicrophone: boolean;
    setShowMicrophone: (showMicrophone: boolean) => void;

    showActsModal: boolean;
    setShowActsModal: (show: boolean) => void;

    newInvoice: Invoice;
    setNewInvoiceSeller: (seller: Company) => void;
    setNewInvoiceBuyer: (seller: Company) => void;
    setNewInvoiceMetadata: (metadata: Metadata) => void;
    setNewInvoiceLines: (lines: InvoiceLine[]) => void;

    showMenu: boolean;
    setShowMenu: (showMenu: boolean) => void;
    menuView: MenuView;
    setMenuView: (view: MenuView) => void;
    editID: string;
    setEditID: (id: string) => void;

    clearVolatileStore: () => void;
}


export const initialVolatileState = {
    showLoading: false,
    hasMediaDevices: true,
    showText: false,
    showCamera: false,
    showMicrophone: false,
    showActsModal: false,
    newInvoice: {
        id: '',
        seller: {...company},
        buyer: {...company},
        metadata: {...emptyMetadata},
        products: [
            {...emptyInvoiceLine},
        ],
    },
    showMenu: true,
    menuView: 'general',
    editID: '',
};


const useVolatileStore = create<VolatileState>()(
    devtools(
    immer(
        (set) => ({
            showLoading: initialVolatileState.showLoading,
            setShowLoading: (showLoading: boolean) => set({ showLoading }),

            hasMediaDevices: initialVolatileState.hasMediaDevices,
            setHasMediaDevices: (hasMediaDevices: boolean) => set({ hasMediaDevices }),

            showText: initialVolatileState.showText,
            setShowText: (showText: boolean) => set({ showText }),

            showCamera: initialVolatileState.showCamera,
            setShowCamera: (showCamera: boolean) => set({ showCamera }),

            showMicrophone: initialVolatileState.showMicrophone,
            setShowMicrophone: (showMicrophone: boolean) => set({ showMicrophone }),

            showActsModal: initialVolatileState.showActsModal,
            setShowActsModal: (showActsModal: boolean) => set({ showActsModal }),

            newInvoice: initialVolatileState.newInvoice,
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

            showMenu: initialVolatileState.showMenu,
            setShowMenu: (showMenu: boolean) => set({ showMenu }),
            menuView: initialVolatileState.menuView as MenuView,
            setMenuView: (menuView: MenuView) => set({ menuView }),
            editID: initialVolatileState.editID,
            setEditID: (editID: string) => set({ editID }),

            clearVolatileStore: () => set(() => ({
                ...initialVolatileState,
            })),
        }),
    ),
    ),
);


export default useVolatileStore;
