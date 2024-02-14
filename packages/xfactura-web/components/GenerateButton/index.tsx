import {
    focusStyle,
} from '@/data/styles';

import {
    styleTrim,
} from '@/logic/utilities';



export default function GenerateButton({
    loadingEInvoice,
    validData,
    generateEinvoice,
}: {
    loadingEInvoice: boolean;
    validData: boolean;
    generateEinvoice: () => void;
}) {
    return (
        <div
            className="grid place-content-center p-8"
        >
            <button
                onClick={() => generateEinvoice()}
                className={styleTrim(`
                    select-none bg-gray-800 disabled:bg-gray-600 hover:bg-gray-900
                    min-w-[200px] py-4 px-4
                    ${focusStyle}
                `)}
                disabled={loadingEInvoice || !validData}
            >
                generare efactura
            </button>
        </div>
    );
}
