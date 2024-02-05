import {
    Inventory,
} from '@/data';

import Input from '@/components/Input';



export default function InventoryItem({
    data,
    atChange,
}: {
    data: Inventory;
    atChange: (data: Inventory) => void;
}) {
    return (
        <div>
            <Input
                text="nume"
                value={data.name}
                setValue={(name) => {
                    atChange({
                        ...data,
                        name,
                    });
                }}
            />
        </div>
    );
}
