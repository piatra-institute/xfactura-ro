import {
    useState,
} from 'react';

import localStorage from '../../data/localStorage';

import MenuBack from '../../components/MenuBack';
import Subtitle from '../../components/Subtitle';



export default function InvoicesList({
    back,
} : {
    back: () => void;
}) {
    const [
        invoices,
        setInvoices,
    ] = useState<any[]>(
        Object.values(localStorage.invoices) as any[],
    );


    return (
        <div>
            <Subtitle
                text="xfacturi"
                centered={true}
            />

            {invoices.length === 0 && (
                <div>
                    nici o xfactură
                </div>
            )}

            <MenuBack
                back={back}
            />
        </div>
    );
}
