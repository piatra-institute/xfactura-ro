import {
    InventoryHistory,
} from '@/data';

import Input from '@/components/Input';
import Datepicker from '@/components/Datepicker';
import Toggle from '@/components/Toggle';
import Deleter from '@/components/Deleter';



export default function InventoryHistoryLine({
    data,
    atChange,
    remove,
}: {
    data: InventoryHistory;
    atChange: (data: InventoryHistory) => void;
    remove: () => void;
}) {
    const {
        date,
        supplier,
        invoice,
        acquisitionPrice,
        quantity,
        vatIncluded,
    } = data;


    return (
        <div
            className="my-8"
        >
            <Datepicker
                text="dată achiziție"
                atSelect={(date) => {
                    atChange({
                        ...data,
                        date,
                    });
                }}
                defaultValue={date}
            />

            <Input
                text="furnizor"
                value={supplier}
                setValue={(supplier) => {
                    atChange({
                        ...data,
                        supplier,
                    });
                }}
            />

            <Input
                text="factură"
                value={invoice}
                setValue={(invoice) => {
                    atChange({
                        ...data,
                        invoice,
                    });
                }}
            />

            <Input
                text="preț achiziție"
                value={acquisitionPrice + ''}
                setValue={(acquisitionPrice) => {
                    atChange({
                        ...data,
                        acquisitionPrice: parseFloat(acquisitionPrice),
                    });
                }}
                type="number"
                inputProps={{
                    min: 0,
                }}
            />

            <Input
                text="cantitate"
                value={quantity + ''}
                setValue={(quantity) => {
                    atChange({
                        ...data,
                        quantity: parseFloat(quantity),
                    });
                }}
                type="number"
                inputProps={{
                    min: 0,
                }}
            />

            <div
                className="my-4"
            >
                <Toggle
                    text="TVA inclus"
                    value={vatIncluded}
                    toggle={() => {
                        atChange({
                            ...data,
                            vatIncluded: !vatIncluded,
                        });
                    }}
                />
            </div>

            <Deleter
                title="șterge achiziție"
                atDelete={remove}
            />
        </div>
    );
}
