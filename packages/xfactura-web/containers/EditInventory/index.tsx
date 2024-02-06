import {
    useState,
} from 'react';

import {
    Inventory,
} from '@/data';

import Subtitle from '@/components/Subtitle';
import InventoryItem from '@/components/InventoryItem';
import MenuBack from '@/components/MenuBack';
import PureButton from '@/components/PureButton';
import Deleter from '@/components/Deleter';

import useStore, {
    useVolatileStore,
} from '@/store';



export default function EditInventory({
    back,
} : {
    back: () => void;
}) {
    const {
        inventory,
        addInventory,
        removeInventory,
    } = useStore();

    const {
        editID,
        setMenuView,
    } = useVolatileStore();

    const [
        inventoryItem,
        setInventoryItem,
    ] = useState<Inventory | null>(
        inventory[editID] || null,
    );


    if (!inventoryItem) {
        return (
            <div>
                <div>
                    stocul nu a fost găsit
                </div>

                <MenuBack
                    back={back}
                />
            </div>
        );
    }

    return (
        <div
            className="scrollable-view overflow-auto h-[calc(100vh-4rem)]"
        >
            <Subtitle
                text="editare stoc"
                centered={true}
            />

            <InventoryItem
                data={inventoryItem}
                atChange={(newInventoryItem) => {
                    setInventoryItem(newInventoryItem);
                }}
            />

            <PureButton
                text="salvare"
                atClick={() => {
                    addInventory(inventoryItem);
                    setMenuView('inventory');
                }}
            />

            <Deleter
                title="ștergere"
                atDelete={() => {
                    removeInventory(inventoryItem.id);
                    setMenuView('inventory');
                }}
            />

            <MenuBack
                back={() => {
                    setMenuView('inventory');
                }}
            />
        </div>
    );
}
