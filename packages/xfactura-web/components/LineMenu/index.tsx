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
    styleTrim,
} from '@/logic/utilities';

import Toggle from '../Toggle';
import Deleter from '../Deleter';



export default function LineMenu({
    data,
    index,
    updateLine,
    removeLine,
}: {
    data: InvoiceLine;
    index: number;
    updateLine: (index: number, type: string, value: string | boolean) => void;
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
                        backdrop-blur-md shadow-2xl p-4
                        lg:right-0 lg:left-auto lg:top-[80px]
                    `)}
                >
                    <Toggle
                        text="TVA inclus"
                        value={data.vatIncluded}
                        toggle={() => updateLine(index, 'vatIncluded', !data.vatIncluded)}
                    />

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
