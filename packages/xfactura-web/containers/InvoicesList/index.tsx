import {
    Invoice,
} from '@/data';

import SearchableList from '@/components/SearchableList';

import useStore from '@/store';



export default function InvoicesList({
    back,
} : {
    back: () => void;
}) {
    const {
        invoices,
    } = useStore();


    const editInvoice = (invoice: Invoice) => {

    }

    return (
        <SearchableList
            name="facturi"
            noItemText="nici o factură"
            data={Object.values(invoices)}
            editItem={editInvoice}
            getItemID={(invoice) => invoice.id}
            getItemName={(invoice) => invoice.metadata.number}
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
