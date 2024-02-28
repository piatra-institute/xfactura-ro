import {
    useState,
    useEffect,
} from 'react';

import Input, {
    MultipleChoice,
} from '@/components/Input';
import LineMenu from '@/components/LineMenu';

import {
    InvoiceLine,
} from '@/data';

import {
    toFixed,
    financial,
    formatNumber,
} from '@/logic/utilities';

import {
    normalizeDiacritics,
} from '@/logic/validation';

import useStore from '@/store';



export default function Line({
    data,
    index,
    currency,
    updateLine,
    updateLineItem,
    removeLine,
}: {
    data: InvoiceLine;
    index: number;
    currency: string;
    updateLine: (index: number, lineData: InvoiceLine) => void;
    updateLineItem: (index: number, type: string, value: string | boolean) => void;
    removeLine: (index: number) => void;
}) {
    const {
        inventory,
    } = useStore();

    const [
        multipleChoicesName,
        setMultipleChoicesName,
    ] = useState<MultipleChoice[]>([]);


    const computeTotal = () => {
        const {
            price,
            quantity,
            vatRate,
            vatIncluded,
        } = data;

        if (
            !price
            || !quantity
            || !vatRate
        ) {
            return '0';
        }

        // const priceInUnits = price * 100;
        // const valueInUnits = priceInUnits * quantity;
        const value = financial(price * quantity);

        if (vatIncluded) {
            return toFixed(value);
        }

        // const vatInUnits = valueInUnits * vatRate / 100;
        // const totalInUnits = valueInUnits + vatInUnits;
        // const total = totalInUnits / 100;
        const vat = financial(value * vatRate / 100);
        const total = financial(value + vat);

        return formatNumber(
            total,
            currency,
        );
    }


    useEffect(() => {
        if (data.name.length < 2) {
            setMultipleChoicesName([]);
            return;
        }

        const name = normalizeDiacritics(data.name.toLowerCase().trim());
        const choices = Object.keys(inventory)
            .filter(key =>
                normalizeDiacritics(
                    inventory[key].name.toLowerCase().trim()
                ).includes(name)
            )
            .map(key => {
                const {
                    id,
                    name,
                    leftInStock,
                    unit,
                } = inventory[key];

                return {
                    id,
                    name,
                    show: `${name} (${leftInStock} ${unit})`,
                };
            });

        if (choices.length === 1 && choices[0].name === data.name) {
            setMultipleChoicesName([]);
            return;
        }

        setMultipleChoicesName(choices);
    }, [
        inventory,
        data.name,
    ]);


    return (
        <li
            className="grid gap-1 mb-10 items-center lg:flex lg:gap-12 lg:mb-4"
        >
            <div
                className="select-none text-center text-gray-500 text-sm lg:mt-11"
            >
                {(index + 1) + '.'}
            </div>

            <Input
                text="denumire"
                value={data.name}
                setValue={(value) => updateLineItem(index, 'name', value)}
                asGrid={true}
                multipleChoices={multipleChoicesName}
                atChoice={(value) => {
                    if (typeof value == 'string') {
                        return;
                    }

                    const item = inventory[value.id];
                    if (item) {
                        updateLine(
                            index,
                            {
                                ...data,
                                name: item.name,
                                price: item.price,
                                vatRate: item.vatRate,
                            },
                        );
                    }
                    setMultipleChoicesName([]);
                }}
            />

            <Input
                text="cantitate"
                value={data.quantity + ''}
                setValue={(value) => updateLineItem(index, 'quantity', value)}
                width={70}
                type="number"
                inputProps={{
                    min: 0,
                }}
                asGrid={true}
            />

            <Input
                text={data.vatIncluded ? 'preț cu TVA' : 'preț'}
                value={data.price + ''}
                setValue={(value) => updateLineItem(index, 'price', value)}
                width={95}
                type="number"
                inputProps={{
                    min: 0,
                }}
                asGrid={true}
            />

            <Input
                text="TVA %"
                value={data.vatRate + ''}
                setValue={(value) => updateLineItem(index, 'vatRate', value)}
                width={65}
                type="number"
                inputProps={{
                    min: 0,
                }}
                asGrid={true}
            />

            <Input
                text="total"
                value={computeTotal()}
                setValue={(_value) => {}}
                width={140}
                disabled={true}
                asGrid={true}
            />

            <LineMenu
                data={data}
                index={index}
                updateLine={updateLineItem}
                removeLine={removeLine}
            />
        </li>
    );
}
