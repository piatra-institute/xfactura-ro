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
            className="scrollable-view overflow-auto h-full w-full p-2"
        >
            <div
                className="w-full px-2 md:w-[400px] md:px-0 m-auto"
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

                <div
                    className="h-6"
                />

                <PureButton
                    text="salvare"
                    atClick={() => {
                        addInventory(inventoryItem);
                        setMenuView('inventory');
                    }}
                />

                <div
                    className="h-6"
                />

                <Deleter
                    title="ștergere stoc"
                    atDelete={() => {
                        removeInventory(inventoryItem.id);
                        setMenuView('inventory');
                    }}
                />

                <MenuBack
                    back={() => {
                        setMenuView('inventory');
                    }}
                    bottomSpace={true}
                />
            </div>
        </div>
    );
}
