import {
    useState,
} from 'react';

import {
    InvoiceLine,
} from '@/data';

import {
    focusStyle,
} from '@/data/styles';

import {
    collapseIcon,
    expandIcon,
} from '@/data/icons';

import {
    emptyInvoiceLineAllowance,
} from '@/data/constants';

import Toggle from '@/components/Toggle';
import LinkButton from '@/components/LinkButton';
import Deleter from '@/components/Deleter';

import {
    styleTrim,
} from '@/logic/utilities';



export default function LineMenu({
    data,
    index,
    updateLine,
    removeLine,
}: {
    data: InvoiceLine;
    index: number;
    updateLine: (index: number, type: string, value: string | boolean | any) => void;
    removeLine: (index: number) => void;
}) {
    const [
        show,
        setShow,
    ] = useState(false);

    return (
        <div
            className="relative"
        >
            <button
                onClick={() => setShow(!show)}
                className={styleTrim(`
                    ${focusStyle} lg:mt-10
                `)}
            >
                {show ? (
                    <>{collapseIcon}</>
                ) : (
                    <>{expandIcon}</>
                )}
            </button>

            {show && (
                <div
                    className={styleTrim(`
                        z-30 absolute top-[40px] left-0 w-[220px] border
                        backdrop-blur-xl bg-black/60 shadow-2xl p-4
                        lg:right-0 lg:left-auto lg:top-[80px]
                    `)}
                >
                    <Toggle
                        text="TVA inclus"
                        value={data.vatIncluded}
                        toggle={() => updateLine(index, 'vatIncluded', !data.vatIncluded)}
                    />

                    {!data.allowance && (
                        <div
                            className="mt-4 mb-2"
                        >
                            <LinkButton
                                text="discount"
                                onClick={() => {
                                    setShow(false);
                                    updateLine(index, 'allowance', {
                                        ...emptyInvoiceLineAllowance,
                                    });
                                }}
                            />
                        </div>
                    )}

                    <div
                        className="mt-4 mb-2"
                    >
                        <Deleter
                            atDelete={() => {
                                setShow(false);
                                removeLine(index);
                            }}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
