import Line from '@/components/Line';
import LinkButton from '@/components/LinkButton';
import Subtitle from '@/components/Subtitle';

import {
    InvoiceLine,
} from '@/data';

import {
    formatNumber,
    financial,
} from '@/logic/utilities';



export default function Lines({
    data,
    setLines,
    addNewLine,
    currency,
}: {
    data: InvoiceLine[];
    setLines: (lines: InvoiceLine[]) => void;
    addNewLine: () => void;
    currency: string;
}) {
    const updateLineItem = (
        index: number,
        type: string,
        value: string | boolean,
    ) => {
        const newLines = data.map((line, idx) => {
            if (idx === index) {
                const parsedValue = typeof value === 'string' &&
                    (type === 'price' || type === 'quantity' || type === 'vatRate')
                    ? parseFloat(value)
                    : value;

                return {
                    ...line,
                    [type]: parsedValue,
                };
            }

            return {
                ...line,
            };
        });

        setLines(newLines);
    }

    const updateLine = (
        index: number,
        lineData: InvoiceLine,
    ) => {
        const newLines = data.map((line, idx) => {
            if (idx === index) {
                return lineData;
            }

            return line;
        });

        setLines(newLines);
    }

    const removeLine = (
        index: number,
    ) => {
        const newLines = data.filter((_, idx) => index !== idx);
        setLines(newLines);
    }

    const quantityPrice = (line: InvoiceLine) => financial(line.price * line.quantity);
    const vatValue = (line: InvoiceLine) => financial(quantityPrice(line) / (1 + line.vatRate / 100));

    const computeWithoutVAT = () => {
        return formatNumber(
            financial(
                data.reduce((acc, line) => {
                    if (line.vatIncluded) {
                        return acc + vatValue(line);
                    }

                    return acc + quantityPrice(line);
                }, 0),
            ),
            currency,
        );
    }

    const computeVAT = () => {
        return formatNumber(
            financial(
                data.reduce((acc, line) => {
                    if (line.vatIncluded) {
                        return acc + financial(quantityPrice(line) - vatValue(line));
                    }

                    return acc + financial(quantityPrice(line) * line.vatRate / 100);
                }, 0),
            ),
            currency,
        );
    }

    const computeTotal = () => {
        return formatNumber(
            financial(
                data.reduce((acc, line) => {
                    if (line.vatIncluded) {
                        return acc + quantityPrice(line);
                    }

                    return acc + financial(quantityPrice(line) * (1 + line.vatRate / 100));
                }, 0),
            ),
            currency,
        );
    }


    return (
        <div
            className="p-2 md:p-8"
        >
            <div
                className='grid place-content-center mb-4'
            >
                <Subtitle
                    text="produse & servicii"
                />
            </div>

            <ul
                className="grid md:place-content-center p-2"
            >
                {data.length === 0 && (
                    <div
                        className="text-center"
                    >
                        niciun produs
                    </div>
                )}

                {data.map((line, index) => {
                    return (
                        <Line
                            key={'line' + index}
                            data={line}
                            index={index}
                            updateLine={updateLine}
                            updateLineItem={updateLineItem}
                            removeLine={removeLine}
                            currency={currency}
                        />
                    );
                })}
            </ul>

            <div
                className="grid md:place-content-center p-2 md:p-8"
            >
                <LinkButton
                    text="adăugare produs"
                    onClick={() => addNewLine()}
                />
            </div>

            <div
                className="grid md:place-content-center p-2 md:p-8"
            >
                <div className="flex justify-between my-2 min-w-[250px]">
                    <div>
                        total fără TVA
                    </div>

                    <div>
                        {computeWithoutVAT()}
                    </div>
                </div>

                <div className="flex justify-between my-2 min-w-[250px]">
                    <div>
                        total TVA
                    </div>

                    <div>
                        {computeVAT()}
                    </div>
                </div>

                <div className="flex justify-between my-2 min-w-[250px]">
                    <div>
                        total
                    </div>
                    <div>
                        {computeTotal()}
                    </div>
                </div>
            </div>
        </div>
    );
}
