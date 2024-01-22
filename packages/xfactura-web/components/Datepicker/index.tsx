import type { CustomFlowbiteTheme } from 'flowbite-react';
import { Flowbite, Datepicker } from 'flowbite-react';



const customTheme: CustomFlowbiteTheme = {
    textInput: {
        "base": "flex",
        "addon": "inline-flex items-center rounded-l-md border border-r-0 border-gray-300 bg-gray-200 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-600 dark:text-gray-400",
        "field": {
            "base": "relative bg-black w-full",
            "icon": {
                "base": "pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3",
                "svg": "h-5 w-5 text-gray-500 dark:text-gray-400"
            },
            "rightIcon": {
                "base": "pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3",
                "svg": "h-5 w-5 text-gray-500 dark:text-gray-400"
            },
            "input": {
                "base": "w-[200px] h-[40px] rounded-none border-none focus:outline-none focus:ring-2 focus:ring-white disabled:cursor-not-allowed disabled:opacity-50",
                "sizes": {
                    "sm": "p-2",
                    "md": "p-2",
                    "lg": "p-2"
                },
                "colors": {
                    "gray": "bg-gray-800 text-white focus:ring-white dark:bg-gray-700 dark:text-white dark:placeholder-gray-400 dark:focus:border-gray-500 dark:focus:ring-gray-500",
                    "info": "border-gray-500 bg-gray-50 text-gray-900 placeholder-gray-700 focus:border-gray-500 focus:ring-gray-500 dark:border-gray-400 dark:bg-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-500",
                    "failure": "border-red-500 bg-red-50 text-red-900 placeholder-red-700 focus:border-red-500 focus:ring-red-500 dark:border-red-400 dark:bg-red-100 dark:focus:border-red-500 dark:focus:ring-red-500",
                    "warning": "border-yellow-500 bg-yellow-50 text-yellow-900 placeholder-yellow-700 focus:border-yellow-500 focus:ring-yellow-500 dark:border-yellow-400 dark:bg-yellow-100 dark:focus:border-yellow-500 dark:focus:ring-yellow-500",
                    "success": "border-green-500 bg-green-50 text-green-900 placeholder-green-700 focus:border-green-500 focus:ring-green-500 dark:border-green-400 dark:bg-green-100 dark:focus:border-green-500 dark:focus:ring-green-500"
                },
                "withRightIcon": {
                    "on": "pr-10",
                    "off": ""
                },
                "withIcon": {
                    "on": "pl-10",
                    "off": ""
                },
                "withAddon": {
                    "on": "",
                    "off": ""
                },
                "withShadow": {
                    "on": "shadow-sm dark:shadow-sm-light",
                    "off": ""
                }
            }
        }
    },
    datepicker: {
        "root": {
            "base": "relative"
        },
        "popup": {
            "root": {
                "base": "absolute top-[45px] right-[-2px] z-50 block pt-2 bg-black text-white",
                "inline": "relative top-0 z-auto",
                "inner": "inline-block p-4 shadow-lg border border-white border-2"
            },
            "header": {
                "base": "bg-black",
                "title": "px-2 py-3 text-center font-semibold  text-white dark:text-white",
                "selectors": {
                    "base": "flex justify-between mb-2",
                    "button": {
                        "base": "text-sm text-white bg-black font-semibold py-2.5 px-5 focus:outline-none focus:ring-2 focus:ring-gray-200 view-switch",
                        "prev": "",
                        "next": "",
                        "view": ""
                    }
                }
            },
            "view": {
                "base": "p-1 text-white"
            },
            "footer": {
                "base": "flex mt-2 space-x-2",
                "button": {
                    "base": "w-full px-5 py-2 text-center text-sm font-medium focus:ring-4 focus:ring-gray-300",
                    "today": "bg-gray-600 text-white hover:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-700",
                    "clear": "border border-gray-300 bg-black text-white hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600"
                }
            }
        },
        "views": {
            "days": {
                "header": {
                    "base": "grid grid-cols-7 mb-1 bg-black",
                    "title": "dow h-6 text-center text-sm font-medium leading-6 text-gray-500 dark:text-gray-400"
                },
                "items": {
                    "base": "grid w-64 text-white grid-cols-7",
                    "item": {
                        "base": "block flex-1 text-white cursor-pointer border-0 text-center text-sm font-semibold leading-9 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-600 hover:text-black",
                        "selected": "bg-gray-700 text-white hover:bg-gray-600",
                        "disabled": "text-gray-500"
                    }
                }
            },
            "months": {
                "items": {
                    "base": "grid w-64 text-white grid-cols-4",
                    "item": {
                        "base": "block flex-1 cursor-pointer border-0 text-center text-white text-sm font-semibold leading-9 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-600 hover:text-black",
                        "selected": "bg-gray-700 text-white hover:bg-gray-600",
                        "disabled": "text-gray-500"
                    }
                }
            },
            "years": {
                "items": {
                    "base": "grid w-64 text-white grid-cols-4",
                    "item": {
                        "base": "block flex-1 cursor-pointer border-0 text-center text-sm font-semibold leading-9 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-600 hover:text-black",
                        "selected": "bg-gray-700 text-white hover:bg-gray-600",
                        "disabled": "text-gray-500"
                    }
                }
            },
            "decades": {
                "items": {
                    "base": "grid w-64 text-white grid-cols-4",
                    "item": {
                        "base": "block flex-1 cursor-pointer border-0 text-center text-sm font-semibold leading-9  hover:bg-gray-100 dark:text-white dark:hover:bg-gray-600 hover:text-black",
                        "selected": "bg-gray-700 text-white hover:bg-gray-600",
                        "disabled": "text-gray-500"
                    }
                }
            }
        }
    }
};


export default function CustomDatepicker({
    text,
    atSelect,
}: {
    text: string;
    atSelect: (timestamp: number) => void;
}) {
    return (
        <div
            className="flex items-center justify-between my-2 gap-4"
        >
            <div
                className="select-none"
            >
                {text}
            </div>

            <Flowbite theme={{ theme: customTheme }}>
                <Datepicker
                    onSelectedDateChanged={(date) => {
                        const timestamp = new Date(date).getTime();
                        atSelect(timestamp);
                    }}
                    weekStart={1}
                    language="ro-RO"
                    labelTodayButton='azi'
                    labelClearButton='resetare'
                    icon={undefined}
                    name={text}
                />
            </Flowbite>
        </div>
    );
}
