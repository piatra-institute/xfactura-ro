import {
    useState,
    useEffect,
} from 'react';

import {
    Invoice,
    Company,
    Metadata as IMetadata,
    InvoiceLine,

    emptyInvoiceLine,
} from '@/data';

import Party from '@/components/Party';
import Lines from '@/components/Lines';
import GenerateButton from '@/components/GenerateButton';
import PureButton from '@/components/PureButton';

import Metadata from '@/containers/Metadata';

import {
    checkValidParty,
    checkValidLine,
    checkValidMetadata,
} from '@/logic/validation';

import {
    generatePdf,
} from '@/logic/pdf';



export default function InvoiceItem({
    data,
    editing,
    updateSeller,
    updateBuyer,
    updateMetadata,
    updateDate,
    updateProducts,
    generateEinvoice,
}: {
    data: Invoice;
    editing?: boolean;
    updateSeller: (data: Company) => void;
    updateBuyer: (data: Company) => void;
    updateMetadata: (
        type: keyof IMetadata,
        value: string | number,
    ) => void;
    updateDate: (
        kind: 'issueDate' | 'dueDate',
        timestamp: number,
    ) => void;
    updateProducts: (data: InvoiceLine[]) => void;
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
                className="grid items-center m-auto px-2 md:px-0 md:justify-center md:flex md:items-start"
            >
                <Party
                    kind="seller"
                    title="furnizor"
                    data={data.seller}
                    setParty={updateSeller}
                    editing={editing}
                />

                <Party
                    kind="buyer"
                    title="cumpărător"
                    data={data.buyer}
                    setParty={updateBuyer}
                    editing={editing}
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

            <PureButton
                text="export pdf"
                atClick={() => {
                    generatePdf(data);
                }}
                disabled={!validData}
            />
        </>
    );
    // #endregion render
}
