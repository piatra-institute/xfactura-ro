'use client';

import {
    Dropdown,
    FlowbiteDropdownTheme,
} from 'flowbite-react';

import Tooltip from '../Tooltip';



const theme: FlowbiteDropdownTheme = {
    "arrowIcon": "ml-2 h-4 w-4",
    "content": "bg-black focus:outline-none",
    "floating": {
        "animation": "transition-opacity",
        "arrow": {
            "base": "absolute z-10 h-2 w-2 rotate-45",
            "style": {
                "dark": "bg-gray-900 dark:bg-gray-700",
                "light": "bg-white",
                "auto": "bg-white dark:bg-gray-700"
            },
            "placement": "-4px"
        },
        "base": "z-10 w-fit border divide-y divide-gray-100 shadow focus:outline-none",
        "content": "py-1 text-sm text-gray-700 dark:text-gray-200",
        "divider": "my-1 h-px bg-gray-100 dark:bg-gray-600",
        "header": "block py-2 px-4 text-sm text-gray-700 dark:text-gray-200",
        "hidden": "invisible opacity-0",
        "item": {
            "container": "bg-black",
            "base": "flex items-center justify-end py-2 px-4 text-sm text-white cursor-pointer w-full hover:bg-gray-100 hover:text-black focus:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-600 focus:outline-none dark:hover:text-white dark:focus:bg-gray-600 dark:focus:text-white",
            "icon": "mr-2 h-4 w-4"
        },
        "style": {
            "dark": "bg-gray-900 text-white dark:bg-gray-700",
            "light": "border border-gray-200 bg-white text-gray-900",
            "auto": "border border-gray-200 bg-white text-gray-900 dark:border-none dark:bg-gray-700 dark:text-white"
        },
        "target": "w-fit"
    },
    "inlineWrapper": "flex items-center"
};


export default function CustomDropdown({
    name,
    selected,
    selectables,
    tooltip,
    atSelect,
}: {
    name: string,
    selected: string,
    selectables: string[],
    tooltip?: React.ReactNode,
    atSelect: (selected: string) => void,
}) {
    return (
        <div
            className="flex items-center justify-between my-2"
        >
            <div
                className="flex items-center justify-between gap-2"
            >
                <div>
                    {name}
                </div>

                {tooltip && (
                    <Tooltip
                        content={(
                            <div
                                className="max-w-[250px] p-2"
                            >
                                {tooltip}
                            </div>
                        )}
                    >
                        <span
                            className="text-gray-400 cursor-pointer"
                        >
                            ?
                        </span>
                    </Tooltip>
                )}
            </div>

            <Dropdown
                label={selected}
                dismissOnClick={true}
                inline={true}
                theme={theme}
                placement="bottom-end"
            >
                {selectables.map((selectable) => {
                    return (
                        <Dropdown.Item
                            key={selectable}
                            onClick={() => {
                                atSelect(selectable);
                            }}
                        >
                            {selectable}
                        </Dropdown.Item>
                    );
                })}
            </Dropdown>
        </div>
    );
}
