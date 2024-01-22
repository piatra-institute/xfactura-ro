import Input from '../Input';
import LineMenu from '../LineMenu';

import {
    InvoiceLine,
} from '../../data';

import {
    toFixed,
    financial,
    formatNumber,
} from '../../logic/utilities';



export default function Line({
    data,
    index,
    currency,
    updateLine,
    removeLine,
}: {
    data: InvoiceLine;
    index: number;
    currency: string;
    updateLine: (index: number, type: string, value: string | boolean) => void;
    removeLine: (index: number) => void;
}) {
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
                setValue={(value) => updateLine(index, 'name', value)}
                asGrid={true}
            />

            <Input
                text="cantitate"
                value={data.quantity + ''}
                setValue={(value) => updateLine(index, 'quantity', value)}
                width={70}
                type="number"
                inputProps={{
                    min: 0,
                }}
                asGrid={true}
            />

            <Input
                text="preț"
                value={data.price + ''}
                setValue={(value) => updateLine(index, 'price', value)}
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
                setValue={(value) => updateLine(index, 'vatRate', value)}
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
                updateLine={updateLine}
                removeLine={removeLine}
            />
        </li>
    );
}
