import {
    Company,
} from '@/data';

import SearchableList from '@/components/SearchableList';

import useStore, {
    useVolatileStore,
} from '@/store';



export default function CompaniesList({
    back,
} : {
    back: () => void;
}) {
    const {
        companies,
    } = useStore();

    const {
        setMenuView,
        setEditID,
    } = useVolatileStore();

    return (
        <SearchableList
            name="companii"
            noItemText="nici o companie"
            data={Object.values(companies)}
            editItem={(company: Company) => {
                setEditID(company.vatNumber);
                setMenuView('edit-company');
            }}
            getItemID={(company) => company.vatNumber}
            getItemName={(company) => company.name}
            checkItemFilter={(company, search) => {
                return (
                    company.vatNumber.toLowerCase().includes(search.toLowerCase()) ||
                    company.name.toLowerCase().includes(search.toLowerCase())
                );
            }}
            back={back}
        />
    );
}
