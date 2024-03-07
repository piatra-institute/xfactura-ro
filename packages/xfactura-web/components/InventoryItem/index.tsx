import { v4 as uuid } from 'uuid';

import {
    Inventory,
} from '@/data';

import Input from '@/components/Input';
import Toggle from '@/components/Toggle';
import LinkButton from '@/components/LinkButton';
import InventoryHistoryLine from '@/components/InventoryHistoryLine';

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


    const computeGross = () => {
        if (!price || history.length === 0) {
            return '';
        }

        const acquisitionPrice = history[history.length - 1].acquisitionPrice;

        if (!acquisitionPrice) {
            return '';
        }

        const value = price - acquisitionPrice;
        if (value < 0) {
            return '';
        }

        return formatNumber(
            price - acquisitionPrice,
            currency,
        );
    }

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
        <div
            className="xxs:w-[400px] mx-auto"
        >
            <Input
                text="nume"
                value={name}
                setValue={(name) => {
                    atChange({
                        ...data,
                        name,
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
                text="unitate"
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


            {history.map((line, index) => {
                return (
                    <InventoryHistoryLine
                        key={line.id}
                        data={line}
                        atChange={(updatedLine) => {
                            const newHistory = history.map((historyLine, i) => {
                                if (i === index) {
                                    return updatedLine;
                                }

                                return historyLine;
                            });

                            atChange({
                                ...data,
                                history: newHistory,
                            });
                        }}
                        remove={() => {
                            const newHistory = history.filter((_, i) => i !== index);

                            atChange({
                                ...data,
                                history: newHistory,
                            });
                        }}
                    />
                );
            })}

            <div
                className="mt-8 mb-12"
            >
            <LinkButton
                text="adaugă achiziție"
                onClick={() => {
                    const newLine = {
                        id: uuid(),
                        date: Date.now(),
                        supplier: '',
                        invoice: '',
                        acquisitionPrice: 0,
                        quantity: 0,
                        vatIncluded: false,
                    };

                    atChange({
                        ...data,
                        history: [
                            ...history,
                            newLine,
                        ],
                    });
                }}
            />
            </div>


            <Input
                text="adaos brut"
                value={computeGross()}
                setValue={(_) => {}}
                disabled={true}
            />

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
