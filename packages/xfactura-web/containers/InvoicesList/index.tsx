import MenuBack from '@/components/MenuBack';
import Subtitle from '@/components/Subtitle';

import useStore from '@/store';



export default function InvoicesList({
    back,
} : {
    back: () => void;
}) {
    const {
        invoices,
    } = useStore();


    return (
        <div>
            <Subtitle
                text="facturi"
                centered={true}
            />

            {Object.values(invoices).length === 0 && (
                <div>
                    nici o factură
                </div>
            )}

            <MenuBack
                back={back}
            />
        </div>
    );
}
