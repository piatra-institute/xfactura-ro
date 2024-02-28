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

export interface MultipleChoice {
    id: string;
    name: string;
    show?: string;
}


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
    multipleChoices?: (string | MultipleChoice)[];
    inputProps?: InputProps;
    atChoice?: (choice: string | MultipleChoice) => void;
}) {
    // #region state
    const [
        showMultiple,
        setShowMultiple,
    ] = useState(false);

    const [
        multipleIndex,
        setMultipleIndex,
    ] = useState(-1);
    // #endregion state


    // #region handlers
    const computeChoiceKey = (
        choice: string | MultipleChoice,
        index: number,
    ) => {
        if (typeof choice === 'string') {
            return choice + index;
        }

        return choice.id + index;
    }

    const renderChoice = (
        choice: string | MultipleChoice,
    ) => {
        if (typeof choice === 'string') {
            return choice;
        }

        return choice.show || choice.name;
    }
    // #endregion handlers


    // #region effects
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
                    event.preventDefault();
                    if (multipleIndex === 0) {
                        setMultipleIndex(-1);
                    } else {
                        setMultipleIndex((multipleIndex - 1 + multipleChoices.length) % multipleChoices.length);
                    }
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

    useEffect(() => {
        if (multipleChoices && multipleChoices.length > 0) {
            setShowMultiple(true);
        } else {
            setShowMultiple(false);
            setMultipleIndex(-1);
        }
    }, [
        multipleChoices,
    ]);
    // #endregion effects


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
                        if (multipleChoices && multipleChoices.length > 0) {
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
                        {multipleChoices.map((choice, index) => (
                            <div
                                key={computeChoiceKey(choice, index)}
                                className={styleTrim(`
                                    ${multipleIndex === multipleChoices.indexOf(choice) ? 'bg-gray-600' : ''}
                                    p-2 -mx-2 text-left
                                `)}
                            >
                                <button
                                    className="cursor-pointer text-left"
                                    onMouseDown={() => {
                                        atChoice?.(choice);
                                    }}
                                >
                                    {renderChoice(choice)}
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
