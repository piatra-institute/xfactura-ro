import MenuBack from '@/components/MenuBack';
import Subtitle from '@/components/Subtitle';

import useStore from '@/store';



export default function InventoryList({
    back,
} : {
    back: () => void;
}) {
    const {
        inventory,
    } = useStore();


    return (
        <div>
            <Subtitle
                text="stocuri"
                centered={true}
            />

            {Object.values(inventory).length === 0 && (
                <div>
                    nici un stoc
                </div>
            )}

            {/* {inventory.map(inventory => {
                return (
                    <div
                        key={inventory.id}
                        className="flex justify-between items-center gap-4 p-2 mb-2 w-full"
                    >
                        <div>
                            {inventory.name}
                        </div>
                    </div>
                );
            })} */}

            <MenuBack
                back={back}
            />
        </div>
    );
}
