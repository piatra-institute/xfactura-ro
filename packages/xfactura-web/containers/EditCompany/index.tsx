import {
    useState,
} from 'react';

import {
    Company,
} from '@/data';

import Subtitle from '@/components/Subtitle';
import MenuBack from '@/components/MenuBack';
import Party from '@/components/Party';
import PureButton from '@/components/PureButton';
import Deleter from '@/components/Deleter';

import useStore, {
    useVolatileStore,
} from '@/store';



export default function EditCompany({
    back,
} : {
    back: () => void;
}) {
    const {
        companies,
        editCompany,
        removeCompany,

        defaultSeller,
    } = useStore();

    const {
        editID,
        setMenuView,
    } = useVolatileStore();

    const [
        company,
        setCompany,
    ] = useState<Company | null>(
        companies[editID] || null,
    );


    if (!company) {
        return (
            <div>
                <div>
                    compania {editID} nu a fost găsită
                </div>

                <MenuBack
                    back={back}
                />
            </div>
        );
    }

    return (
        <div
            className="scrollable-view overflow-auto p-2 grid md:place-content-center"
        >
            <Subtitle
                text="editare companie"
                centered={true}
            />

            <div
                className="p-2"
            >
                <Party
                    kind={defaultSeller === company.vatNumber ? 'seller' : 'buyer'}
                    title=""
                    data={company}
                    setParty={setCompany}
                    styleless={true}
                    editing={true}
                />
            </div>

            <PureButton
                text="salvare"
                atClick={() => {
                    editCompany(company);
                    setMenuView('companies');
                }}
            />

            <Deleter
                title="ștergere"
                atDelete={() => {
                    removeCompany(company.vatNumber);
                    setMenuView('companies');
                }}
            />

            <MenuBack
                back={() => {
                    setMenuView('companies');
                }}
                bottomSpace={true}
            />
        </div>
    );
}
