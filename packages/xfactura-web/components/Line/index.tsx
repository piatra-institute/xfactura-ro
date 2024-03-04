import {
    useState,
    useEffect,
} from 'react';

import Input, {
    MultipleChoice,
} from '@/components/Input';
import LineMenu from '@/components/LineMenu';
import Toggle from '@/components/Toggle';
import LinkButton from '@/components/LinkButton';

import {
    InvoiceLine,
} from '@/data';

import {
    computeAllowance,
} from '@/logic/financial';

import {
    toFixed,
    financial,
    formatNumber,
} from '@/logic/utilities';

import fuzzySearch, {
    inventorySearcher,
} from '@/logic/searchers';

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
    updateLineItem: (index: number, type: string, value: string | boolean | any) => void;
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

        const allowance = computeAllowance(data);
        // const priceInUnits = price * 100;
        // const valueInUnits = priceInUnits * quantity;
        const value = financial(price * quantity - allowance);

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


    // #region effects
    /** Inventory search */
    useEffect(() => {
        if (data.name.length < 2) {
            setMultipleChoicesName([]);
            return;
        }

        const name = normalizeDiacritics(data.name.toLowerCase().trim());

        inventorySearcher.indexEntities(
            Object.values(inventory),
            (entity) => entity.id,
            (entity) => [entity.name],
        );
        const result = inventorySearcher.getMatches(new fuzzySearch.Query(
            name,
            Infinity,
            0.2,
        ));

        if (
            result.matches.length === 0
            || result.matches.some(match => match.quality === 1)
        ) {
            setMultipleChoicesName([]);
            return;
        }

        const choices = result.matches.map((match) => {
            const {
                id,
                name,
                leftInStock,
                unit,
            } = inventory[match.entity.id];

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
    // #endregion effects


    return (
        <>
        <li
            className="mb-8 grid gap-1 items-center lg:flex lg:gap-12 lg:mb-4"
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
                    inputMode: 'decimal',
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
                    inputMode: 'decimal',
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
                    inputMode: 'decimal',
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

        {data.allowance && (
            <div
                className="mb-8 grid gap-1 items-center lg:flex lg:gap-12 lg:mb-4"
            >
                <Input
                    text="nume"
                    value={data.allowance.reason}
                    setValue={(value) => updateLineItem(index, 'allowance', {
                        ...data.allowance,
                        reason: value,
                    })}
                    width={150}
                    inputProps={{
                        placeholder: 'discount',
                    }}
                />

                <Input
                    text="valoare"
                    value={data.allowance.amount + ''}
                    setValue={(value) => updateLineItem(index, 'allowance', {
                        ...data.allowance,
                        amount: parseFloat(value),
                    })}
                    width={150}
                    type="number"
                    inputProps={{
                        min: 0,
                    }}
                />

                <Toggle
                    text="procentaj"
                    value={!data.allowance.fixedAmount}
                    toggle={() => updateLineItem(index, 'allowance', {
                        ...data.allowance,
                        fixedAmount: !data.allowance!.fixedAmount,
                    })}
                />

                <LinkButton
                    text="eliminare discount"
                    onClick={() => updateLineItem(index, 'allowance', null)}
                />
            </div>
        )}
        </>
    );
}
