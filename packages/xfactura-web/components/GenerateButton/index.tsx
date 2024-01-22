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
                className="select-none bg-gray-800 disabled:bg-gray-600 hover:bg-gray-900 py-2 px-4 focus:outline-none focus:ring-2 focus:ring-white"
                disabled={loadingEInvoice || !validData}
            >
                generare efactura
            </button>
        </div>
    );
}
