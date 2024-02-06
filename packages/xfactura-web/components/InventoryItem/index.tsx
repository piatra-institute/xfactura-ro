import {
    Inventory,
} from '@/data';

import Input from '@/components/Input';
import Toggle from '@/components/Toggle';

import {
    formatNumber,
} from '@/logic/utilities';



export default function InventoryItem({
    data,
    atChange,
}: {
    data: Inventory;
    atChange: (data: Inventory) => void;
}) {
    const {
        name,
        price,
        leftInStock,
        unit,
        currency,
        vatRate,
        vatIncluded,
        history,
    } = data;


    const computeValueWithoutVAT = () => {
        if (!price || !leftInStock) {
            return '';
        }

        if (vatIncluded) {
            return formatNumber(
                price * leftInStock / (1 + vatRate / 100),
                currency,
            );
        }

        return formatNumber(price * leftInStock, currency);
    }

    const computeVAT = () => {
        if (!price || !leftInStock || !vatRate) {
            return '';
        }

        if (vatIncluded) {
            return formatNumber(
                (price * leftInStock) - (price * leftInStock / (1 + vatRate / 100)),
                currency,
            );
        }

        return formatNumber(
            (price * vatRate / 100) * leftInStock,
            currency,
        );
    }

    const computeTotal = () => {
        if (!price || !leftInStock || !vatRate) {
            return '';
        }

        if (vatIncluded) {
            return formatNumber(
                price * leftInStock,
                currency,
            );
        }

        return formatNumber(
            (price + price * vatRate / 100) * leftInStock,
            currency,
        );
    }


    return (
        <div>
            <Input
                text="nume"
                value={name}
                setValue={(name) => {
                    atChange({
                        ...data,
                        name: name.trim(),
                    });
                }}
            />

            <Input
                text="preț"
                value={price + ''}
                setValue={(price) => {
                    atChange({
                        ...data,
                        price: parseFloat(price),
                    });
                }}
                type="number"
                inputProps={{
                    min: 0,
                }}
            />

            <Input
                text="în stoc"
                value={leftInStock + ''}
                setValue={(leftInStock) => {
                    atChange({
                        ...data,
                        leftInStock: parseFloat(leftInStock),
                    });
                }}
                type="number"
                inputProps={{
                    min: 0,
                }}
            />

            <Input
                text="UM"
                value={unit}
                setValue={(unit) => {
                    atChange({
                        ...data,
                        unit: unit.trim(),
                    });
                }}
            />

            <Input
                text="monedă"
                value={currency}
                setValue={(currency) => {
                    atChange({
                        ...data,
                        currency: currency.trim(),
                    });
                }}
            />

            <Input
                text="TVA %"
                value={vatRate + ''}
                setValue={(vatRate) => {
                    atChange({
                        ...data,
                        vatRate: parseFloat(vatRate),
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

            <Input
                text="valoare"
                value={computeValueWithoutVAT()}
                setValue={(_) => {}}
                disabled={true}
            />

            <Input
                text="TVA"
                value={computeVAT()}
                setValue={(_) => {}}
                disabled={true}
            />

            <Input
                text="total"
                value={computeTotal()}
                setValue={(_) => {}}
                disabled={true}
            />
        </div>
    );
}
