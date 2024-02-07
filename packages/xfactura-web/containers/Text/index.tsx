import PureButton from '@/components/PureButton';
import LinkButton from '@/components/LinkButton';

import {
    focusStyle,
} from '@/data/styles';

import {
    useVolatileStore,
} from '@/store';



export default function Text() {
    const {
        setShowText,
    } = useVolatileStore();


    return (
        <div
            className={`flex flex-col justify-center items-center gap-4 m-2 `}
        >
            <textarea
                className={`w-[500px] m-auto h-40 bg-gray-800 p-4 border-none ${focusStyle}`}
            />

            <div
                className="flex gap-8"
            >
                <PureButton
                    text="generare"
                    atClick={() => {

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
