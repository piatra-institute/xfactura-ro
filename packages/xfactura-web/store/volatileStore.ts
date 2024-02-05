import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Required for zustand.
import type { } from '@redux-devtools/extension';



export type MenuView =
    | 'general' | 'about' | 'ai'
    | 'companies' | 'edit-company'
    | 'inventory' | 'edit-inventory'
    | 'invoices' | 'edit-invoice'
    | 'settings';


export interface VolatileState {
    showMenu: boolean;
    setShowMenu: (showMenu: boolean) => void;
    menuView: MenuView;
    setMenuView: (view: MenuView) => void;
    editID: string;
    setEditID: (id: string) => void;
}


const useVolatileStore = create<VolatileState>()(
    devtools(
    immer(
        (set) => ({
            showMenu: true,
            setShowMenu: (showMenu: boolean) => set({ showMenu }),
            menuView: 'general',
            setMenuView: (menuView: MenuView) => set({ menuView }),
            editID: '',
            setEditID: (editID: string) => set({ editID }),
        }),
    ),
    ),
);


export default useVolatileStore;
