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



export default function SearchableList<T extends object>({
    name,
    noItemText,
    data,
    editItem,
    getItemID,
    getItemName,
    checkItemFilter,
    back,
} : {
    name: string;
    noItemText: string;
    data: T[];
    editItem: (item: T) => void;
    getItemID: (item: T) => string;
    getItemName: (item: T) => string;
    checkItemFilter: (item: T, search: string) => boolean;
    back: () => void;
}) {
    const [
        search,
        setSearch,
    ] = useState('');

    const [
        filteredData,
        setFilteredData,
    ] = useState(data);


    useEffect(() => {
        if (!search) {
            setFilteredData(data);
            return;
        }

        setFilteredData(data.filter(company => {
            return checkItemFilter(company, search);
        }));
    }, [
        search,
        data,
        checkItemFilter,
    ]);


    return (
        <div
            className="w-[350px]"
        >
            <Subtitle
                text={name}
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
                {filteredData.length === 0 ? (
                    <>
                        {noItemText}
                    </>
                ) : (
                    <>
                        {filteredData.map(item => {
                            return (
                                <div
                                    key={getItemID(item)}
                                    className="flex justify-between items-center w-full gap-4 p-2 mb-2"
                                >
                                    <div
                                        className="flex justify-between items-center w-full gap-2"
                                    >
                                        <div
                                            className="select-all"
                                        >
                                            {getItemID(item)}
                                        </div>

                                        <div
                                            className="select-all"
                                        >
                                            {getItemName(item)}
                                        </div>
                                    </div>

                                    <button
                                        className={styleTrim(`
                                            cursor-pointer select-none
                                            ${focusStyle}
                                            p-1.5
                                        `)}
                                        onClick={() => {
                                            editItem(item);
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
