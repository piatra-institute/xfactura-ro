import { v4 as uuid } from 'uuid';

import {
    emptyInventory,
} from '@/data';

import SearchableList from '@/components/SearchableList';
import TooltipQuestion from '@/components/TooltipQuestion';

import useStore, {
    useVolatileStore,
} from '@/store';

import {
    formatNumber,
} from '@/logic/utilities';



export default function InventoryList({
    back,
} : {
    back: () => void;
}) {
    const {
        inventory,
        addInventory,
    } = useStore();

    const {
        setMenuView,
        setEditID,
    } = useVolatileStore();

    return (
        <SearchableList
            name="stocuri"
            noItemText="nici un stoc"
            data={Object.values(inventory)}
            editItem={(inventory) => {
                setEditID(inventory.id);
                setMenuView('edit-inventory');
            }}
            addNewItem={() => {
                const newInventory = {
                    ...emptyInventory,
                    id: uuid(),
                    name: 'stoc nou',
                };

                addInventory(newInventory);
                setEditID(newInventory.id);
                setMenuView('edit-inventory');
            }}
            addNewItemText="adaugă stoc nou"
            getItemID={(inventory) => inventory.id}
            getItemName={(inventory) => {
                return (
                    <>
                        <div
                            className="select-all text-left"
                        >
                            {inventory.name || 'stoc nou'} ({inventory.leftInStock} {inventory.unit})
                        </div>

                        <div
                            className="select-all text-right flex gap-2"
                        >
                            <div>
                                {formatNumber(
                                    inventory.price,
                                    inventory.currency,
                                )}
                            </div>

                            <TooltipQuestion
                                content={(
                                    <div>
                                        valoare {formatNumber(
                                            inventory.price * inventory.leftInStock,
                                            inventory.currency,
                                        )}
                                    </div>
                                )}
                            />
                        </div>
                    </>
                );
            }}
            checkItemFilter={(inventory, search) => {
                return (
                    inventory.name.toLowerCase().includes(search.toLowerCase()) ||
                    (inventory.price + '').toLowerCase().includes(search.toLowerCase())
                );
            }}
            back={back}
        />
    );
}
