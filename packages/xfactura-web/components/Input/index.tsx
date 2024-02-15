import {
    DetailedHTMLProps,
    InputHTMLAttributes,
    useState,
    useEffect,
} from 'react';

import {
    focusStyle,
} from '@/data/styles';

import Spinner from '@/components/Spinner';

import {
    styleTrim,
} from '@/logic/utilities';



export type InputProps = DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>;


export default function Input({
    text,
    value,
    setValue,
    width,
    type,
    disabled,
    loading,
    inputProps,
    asGrid,
    multipleChoices,
    atChoice,
}: {
    text: string;
    value: string | undefined;
    setValue: (value: string) => void;
    width?: number | string;
    type?: string;
    disabled?: boolean;
    loading?: boolean;
    asGrid?: boolean;
    multipleChoices?: string[];
    inputProps?: InputProps;
    atChoice?: (choice: string) => void;
}) {
    const [
        showMultiple,
        setShowMultiple,
    ] = useState(false);

    const [
        multipleIndex,
        setMultipleIndex,
    ] = useState(-1);


    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!multipleChoices) {
                return;
            }

            if (showMultiple) {
                if (event.key === 'ArrowDown') {
                    setMultipleIndex((multipleIndex + 1) % multipleChoices.length);
                }
                if (event.key === 'ArrowUp') {
                    setMultipleIndex((multipleIndex - 1 + multipleChoices.length) % multipleChoices.length);
                }
                if (event.key === 'Enter') {
                    atChoice?.(multipleChoices[multipleIndex]);
                    setShowMultiple(false);
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [
        showMultiple,
        multipleIndex,
        multipleChoices,
        atChoice,
    ]);


    return (
        <div
            className={styleTrim(`
                flex relative items-center justify-between my-2 gap-4
                ${asGrid ? 'lg:grid' : 'lg:flex'}
            `)}
        >
            {text && (
                <div
                    className="select-none"
                >
                    {text}
                </div>
            )}

            <div
                className="relative w-[200px]"
                style={{
                    width,
                }}
            >
                <input
                    className={styleTrim(`
                        bg-gray-800 w-[200px] p-2 border-none rounded-none text-white
                        disabled:bg-gray-600
                        ${focusStyle}
                    `)}
                    name={text}
                    value={value || ''}
                    type={type}
                    disabled={disabled}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    style={{
                        width,
                    }}
                    {...inputProps}
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                    onFocus={() => {
                        setShowMultiple(true);
                    }}
                    onBlur={() => {
                        setShowMultiple(false);
                        setMultipleIndex(-1);
                    }}
                    onKeyDown={() => {
                        if (multipleChoices) {
                            setShowMultiple(true);
                        } else {
                            setShowMultiple(false);
                            setMultipleIndex(-1);
                        }
                    }}
                />

                {showMultiple
                && multipleChoices
                && multipleChoices.length > 0
                && (
                    <div
                        className={styleTrim(`
                            absolute z-40 bg-gray-800 top-[40px] -left-[2px] w-[204px] p-2
                            border-white border-x-2 border-b-2 rounded-none text-white
                            max-h-[150px] overflow-y-auto
                        `)}
                    >
                        {multipleChoices.map(choice => (
                            <div
                                key={choice}
                                className={styleTrim(`
                                    ${multipleIndex === multipleChoices.indexOf(choice) ? 'bg-gray-600' : ''}
                                    p-2 -mx-2 text-left
                                `)}
                            >
                                <button
                                    className="cursor-pointer text-left"
                                    onClick={() => {
                                        atChoice?.(choice);
                                    }}
                                >
                                    {choice}
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {loading && (
                <Spinner
                    absolute={true}
                    style={{
                        zIndex: 1,
                        right: '4px',
                        top: '19px',
                    }}
                />
            )}
        </div>
    );
}
