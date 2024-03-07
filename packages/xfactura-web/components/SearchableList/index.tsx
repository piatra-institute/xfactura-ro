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
import PureButton from '@/components/PureButton';
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
    addNewItem,
    addNewItemText,
} : {
    name: string;
    noItemText: string;
    data: T[];
    editItem: (item: T) => void;
    getItemID: (item: T) => string;
    getItemName: (item: T) => string | React.ReactNode;
    checkItemFilter: (item: T, search: string) => boolean;
    back: () => void;
    addNewItem?: () => void;
    addNewItemText?: string;
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
            className="w-full mx-auto p-2 sm:w-[400px]"
        >
            <Subtitle
                text={name}
                centered={true}
            />

            <div
                className="p-2 min-h-[72px]"
            >
                <Input
                    text=""
                    value={search}
                    setValue={(value) => {
                        setSearch(value);
                    }}
                    width="100%"
                    inputProps={{
                        placeholder: 'căutare',
                        inputMode: 'search',
                    }}
                />
            </div>

            <div
                className="h-[300px] md:h-[350px] mt-8 flex flex-col overflow-auto scrollable-view"
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
                                        className="flex justify-between items-center w-full gap-4"
                                    >
                                        {getItemName(item)}
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

            {addNewItem && (
                <PureButton
                    text={addNewItemText || 'adaugă'}
                    atClick={addNewItem}
                />
            )}

            <MenuBack
                back={back}
            />
        </div>
    );
}
