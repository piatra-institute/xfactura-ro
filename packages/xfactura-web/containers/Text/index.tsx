import {
    useState,
} from 'react';

import PureButton from '@/components/PureButton';
import LinkButton from '@/components/LinkButton';

import {
    focusStyle,
} from '@/data/styles';

import useStore, {
    useVolatileStore,
} from '@/store';



export default function Text({
    extractInvoiceFromText,
} : {
    extractInvoiceFromText: (text: string) => void,
}) {
    const {
        intelligentActs,
    } = useStore();

    const {
        setShowText,
    } = useVolatileStore();


    const [
        text,
        setText,
    ] = useState('');


    return (
        <div
            className={`flex flex-col justify-center items-center gap-4 m-2`}
        >
            <textarea
                value={text}
                onChange={(event) => {
                    setText(event.target.value);
                }}
                className={`w-full md:w-[500px] m-auto h-40 bg-gray-800 p-4 border-none ${focusStyle}`}
            />

            <div
                className="flex gap-8"
            >
                <PureButton
                    text="generare"
                    atClick={() => {
                        extractInvoiceFromText(text);
                    }}
                />

                <LinkButton
                    text="anulare"
                    onClick={() => {
                        setShowText(false);
                    }}
                />
            </div>
        </div>
    );
}
