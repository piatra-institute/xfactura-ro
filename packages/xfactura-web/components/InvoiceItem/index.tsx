import {
    useState,
    useEffect,
} from 'react';

import {
    Invoice,

    emptyInvoiceLine,
} from '@/data';

import Party from '@/components/Party';
import Lines from '@/components/Lines';
import GenerateButton from '@/components/GenerateButton';

import Metadata from '@/containers/Metadata';

import {
    checkValidParty,
    checkValidLine,
    checkValidMetadata,
} from '@/logic/validation';



export default function InvoiceItem({
    data,
    updateSeller,
    updateBuyer,
    updateMetadata,
    updateDate,
    updateProducts,
    generateEinvoice,
}: {
    data: Invoice;
    updateSeller: (data: any) => void;
    updateBuyer: (data: any) => void;
    updateMetadata: (data: any) => void;
    updateDate: (
        kind: 'issueDate' | 'dueDate',
        timestamp: number,
    ) => void;
    updateProducts: (data: any) => void;
    generateEinvoice: (
        setLoadingEInvoice: (value: boolean) => void,
    ) => void;
}) {
    // #region state
    const [
        loadingEInvoice,
        setLoadingEInvoice,
    ] = useState(false);

    const [
        validData,
        setValidData,
    ] = useState(false);
    // #endregion state


    // #region effects
    /** valid data */
    useEffect(() => {
        const validSeller = checkValidParty(data.seller);
        const validBuyer = checkValidParty(data.buyer);
        const validMetadata = checkValidMetadata(data.metadata);
        const validLines = data.products.every(checkValidLine);

        const validData = (
            validSeller &&
            validBuyer &&
            validMetadata &&
            validLines
        );

        setValidData(validData);
    }, [
        data,
        data.seller,
        data.buyer,
        data.metadata,
        data.products,
    ]);
    // #endregion effects


    // #region render
    return (
        <>
            <div
                className="grid items-center justify-center md:flex m-auto"
            >
                <Party
                    kind="seller"
                    title="furnizor"
                    data={data.seller}
                    setParty={updateSeller}
                />

                <Party
                    kind="buyer"
                    title="cumpărător"
                    data={data.buyer}
                    setParty={updateBuyer}
                />
            </div>

            <Metadata
                metadata={data.metadata}
                updateMetadata={updateMetadata}
                updateDate={updateDate}
            />

            <Lines
                data={data.products}
                setLines={updateProducts}
                addNewLine={() => {
                    updateProducts([
                        ...data.products,
                        {
                            ...emptyInvoiceLine,
                        },
                    ]);
                }}
                currency={data.metadata.currency}
            />

            <GenerateButton
                loadingEInvoice={loadingEInvoice}
                validData={validData}
                generateEinvoice={() => generateEinvoice(setLoadingEInvoice)}
            />
        </>
    );
    // #endregion render
}
