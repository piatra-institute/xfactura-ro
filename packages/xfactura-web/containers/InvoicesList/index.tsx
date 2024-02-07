import SearchableList from '@/components/SearchableList';
import TooltipQuestion from '@/components/TooltipQuestion';

import useStore, {
    useVolatileStore,
} from '@/store';

import {
    invoiceTotal,
} from '@/logic/einvoice';

import {
    formatNumber,
} from '@/logic/utilities';



export default function InvoicesList({
    back,
} : {
    back: () => void;
}) {
    const {
        invoices,
    } = useStore();

    const {
        setMenuView,
        setEditID,
    } = useVolatileStore();

    return (
        <SearchableList
            name="facturi"
            noItemText="nici o factură"
            data={Object.values(invoices)}
            editItem={(invoice) => {
                setEditID(invoice.id);
                setMenuView('edit-invoice');
            }}
            getItemID={(invoice) => invoice.id}
            getItemName={(invoice) => {
                return (
                    <>
                        <div>
                            {new Date(invoice.metadata.dueDate).toLocaleDateString()} · {invoice.metadata.number}
                        </div>

                        <TooltipQuestion
                            content={(
                                <>
                                    <div
                                        className="text-left flex gap-2 items-center"
                                    >
                                        <div>
                                            {invoice.seller.name}
                                        </div>

                                        <div>
                                            »
                                        </div>

                                        <div>
                                            {invoice.buyer.name}
                                        </div>
                                    </div>

                                    <div
                                        className="mt-2"
                                    >
                                        {formatNumber(
                                            invoiceTotal(invoice),
                                            invoice.metadata.currency,
                                        )}
                                    </div>
                                </>
                            )}
                        />
                    </>
                );
            }}
            checkItemFilter={(invoice, search) => {
                return (
                    invoice.buyer.name.toLowerCase().includes(search.toLowerCase()) ||
                    invoice.seller.name.toLowerCase().includes(search.toLowerCase())
                );
            }}
            back={back}
        />
    );
}
