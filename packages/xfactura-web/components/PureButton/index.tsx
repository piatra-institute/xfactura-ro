import {
    focusStyle,
} from '@/data/styles';

import {
    styleTrim,
} from '@/logic/utilities';



export default function PureButton({
    text,
    disabled,
    atClick,
}: {
    text: string;
    disabled?: boolean;
    atClick: () => void;
}) {
    return (
        <div
            className="grid place-content-center p-8"
        >
            <button
                onClick={() => atClick()}
                className={styleTrim(`
                    select-none bg-gray-800 disabled:bg-gray-600 hover:bg-gray-900 py-2 px-4
                    ${focusStyle}
                `)}
                disabled={disabled}
            >
                {text}
            </button>
        </div>
    );
}
