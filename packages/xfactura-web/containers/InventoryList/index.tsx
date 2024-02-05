import {
    Inventory,
} from '@/data';

import SearchableList from '@/components/SearchableList';

import useStore from '@/store';



export default function InventoryList({
    back,
} : {
    back: () => void;
}) {
    const {
        inventory,
    } = useStore();


    const editInventory = (inventory: Inventory) => {

    }


    return (
        <SearchableList
            name="stocuri"
            noItemText="nici un stoc"
            data={Object.values(inventory)}
            editItem={editInventory}
            getItemID={(inventory) => inventory.id}
            getItemName={(inventory) => inventory.name}
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
