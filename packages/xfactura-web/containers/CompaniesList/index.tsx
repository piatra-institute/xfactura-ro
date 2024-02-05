import {
    useState,
    useEffect,
} from 'react';

import {
    editIcon,
} from '@/data/icons';

import {
    focusStyle,
} from '@/data/styles';

import {
    styleTrim,
} from '@/logic/utilities';

import MenuBack from '@/components/MenuBack';
import Subtitle from '@/components/Subtitle';
import Input from '@/components/Input';

import useStore from '@/store';



export default function CompaniesList({
    back,
} : {
    back: () => void;
}) {
    const {
        companies,
    } = useStore();

    const [
        search,
        setSearch,
    ] = useState('');

    const [
        filteredCompanies,
        setFilteredCompanies,
    ] = useState(Object.values(companies));


    const editCompany = (vatNumber: string) => {
    }


    useEffect(() => {
        if (!search) {
            setFilteredCompanies(Object.values(companies));
            return;
        }

        setFilteredCompanies(Object.values(companies).filter(company => {
            return (
                company.vatNumber.toLowerCase().includes(search.toLowerCase()) ||
                company.name.toLowerCase().includes(search.toLowerCase())
            );
        }));
    }, [
        search,
        companies,
    ]);


    return (
        <div
            className="w-[350px]"
        >
            <Subtitle
                text="companii"
                centered={true}
            />

            <Input
                text=""
                value={search}
                setValue={(value) => {
                    setSearch(value);
                }}
                inputProps={{
                    placeholder: "căutare",
                    style: {
                        width: '100%',
                    },
                }}
            />

            <div
                // FIX scroll
                className="h-[350px] mt-8 flex flex-col overflow-auto"
            >
                {filteredCompanies.length === 0 ? (
                    <>
                        nici o companie
                    </>
                ) : (
                    <>
                        {filteredCompanies.map(company => {
                            return (
                                <div
                                    key={company.vatNumber}
                                    className="flex justify-between items-center w-full gap-4 p-2 mb-2"
                                >
                                    <div
                                        className="flex justify-between items-center w-full gap-2"
                                    >
                                        <div>
                                            {company.vatNumber}
                                        </div>

                                        <div>
                                            {company.name}
                                        </div>
                                    </div>

                                    <button
                                        className={styleTrim(`
                                            cursor-pointer select-none
                                            ${focusStyle}
                                            p-1.5
                                        `)}
                                        onClick={() => {
                                            editCompany(company.vatNumber);
                                        }}
                                    >
                                        {editIcon}
                                    </button>
                                </div>
                            );
                        })}
                    </>
                )}
            </div>

            <MenuBack
                back={back}
            />
        </div>
    );
}
