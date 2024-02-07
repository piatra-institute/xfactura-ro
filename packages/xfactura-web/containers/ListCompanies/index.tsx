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
            editItem={(company) => {
                setEditID(company.vatNumber);
                setMenuView('edit-company');
            }}
            getItemID={(company) => company.vatNumber}
            getItemName={(company) => {
                return (
                    <>
                        <div
                            className="select-all"
                        >
                            {company.vatNumber}
                        </div>

                        <div
                            className="select-all"
                        >
                            {company.name}
                        </div>
                    </>
                );
            }}
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
