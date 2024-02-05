import SearchableList from '@/components/SearchableList';

import useStore, {
    useVolatileStore,
} from '@/store';



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
