'use client';

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
    useResponsiveWidth,
} from '@/logic/hooks';

import {
    styleTrim,
} from '@/logic/utilities';



export type InputProps = DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>;

export interface MultipleChoice {
    id: string;
    name: string;
    show?: string;
}

export interface InputProperties {
    text: string;
    value: string | undefined;
    setValue: (value: string) => void;
    width?: number | string;
    type?: string;
    disabled?: boolean;
    forcedValue?: string;
    loading?: boolean;
    asGrid?: boolean;
    multipleChoices?: (string | MultipleChoice)[];
    multipleChoiceFocusable?: boolean;
    inputProps?: InputProps;
    atChoice?: (choice: string | MultipleChoice) => void;
}


export default function Input(
    properties: InputProperties,
) {
    // #region properties
    const {
        text,
        value,
        setValue,
        width,
        type,
        disabled,
        forcedValue,
        loading,
        inputProps,
        asGrid,
        multipleChoices,
        multipleChoiceFocusable,
        atChoice,
    } = properties;

    const responsiveWidth = useResponsiveWidth(width);
    // #endregion properties


    // #region state
    const [mounted, setMounted] = useState(false);

    const [
        focusedInput,
        setFocusedInput,
    ] = useState(multipleChoiceFocusable ? false : true);

    const [
        showMultiple,
        setShowMultiple,
    ] = useState(false);

    const [
        multipleIndex,
        setMultipleIndex,
    ] = useState(-1);

    const [
        typedValue,
        setTypedValue,
    ] = useState(value || '');
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

    const isActiveChoice = (
        choice: string | MultipleChoice,
    ) => {
        if (typeof choice === 'string') {
            return choice === value;
        }

        return choice.show === value;
    }

    const resolveValue = () => {
        if (type === 'number' && forcedValue) {
            return forcedValue;
        }

        if (
            type === 'number'
            && (typedValue.endsWith('.') || typedValue.endsWith(','))
        ) {
            return typedValue;
        }

        return value;
    }
    // #endregion handlers


    // #region effects
    /** Mounted */
    useEffect(() => {
        setMounted(true);
    }, []);

    /** Handle keys */
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!multipleChoices) {
                return;
            }

            if (showMultiple && focusedInput) {
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
        focusedInput,
        atChoice,
    ]);

    /** Multiple choices */
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


    // #region render
    if (!mounted) {
        return;
    }

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
                className={styleTrim(`
                    relative w-[220px] md:w-[200px]
                `)}
                style={{
                    width: responsiveWidth,
                }}
            >
                <input
                    className={styleTrim(`
                        bg-gray-800 w-full p-2 border-none rounded-none text-white
                        disabled:bg-gray-600
                        ${focusStyle}
                    `)}
                    name={text}
                    value={resolveValue()}
                    type={type}
                    disabled={disabled}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    lang="ro-Ro"
                    {...inputProps}
                    onChange={(event) => {
                        const value = event.target.value;

                        setTypedValue(value);
                        setValue(value);
                    }}
                    onFocus={() => {
                        setShowMultiple(true);

                        if (multipleChoiceFocusable) {
                            setFocusedInput(true);
                        }
                    }}
                    onBlur={() => {
                        setShowMultiple(false);
                        setMultipleIndex(-1);

                        if (multipleChoiceFocusable) {
                            setTimeout(() => {
                                setFocusedInput(false);
                            }, 10);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (multipleChoices && multipleChoices.length > 0) {
                            setShowMultiple(true);
                        } else {
                            setShowMultiple(false);
                            setMultipleIndex(-1);
                        }

                        if (multipleChoiceFocusable && event.key === 'Enter') {
                            setTimeout(() => {
                                setFocusedInput(false);
                            }, 10);
                        }
                    }}
                    onWheel={(event) => {
                        try {
                            (event.target as any).blur();
                        } catch (error) {
                            return;
                        }
                    }}
                />

                {showMultiple
                && focusedInput
                && multipleChoices
                && multipleChoices.length > 0
                && (
                    <div
                        className={styleTrim(`
                            absolute z-40 bg-gray-800 top-[40px] -left-[2px] w-[calc(100%+4px)] p-2
                            border-white border-x-2 border-b-2 rounded-none text-white
                            max-h-[150px] overflow-y-auto
                        `)}
                    >
                        {multipleChoices.map((choice, index) => (
                            <div
                                key={computeChoiceKey(choice, index)}
                                className={styleTrim(`
                                    ${
                                        multipleIndex === multipleChoices.indexOf(choice)
                                            ? 'bg-gray-500'
                                            : isActiveChoice(choice) ? 'bg-gray-600' : ''
                                    }
                                    p-2 -mx-2 text-left
                                `)}
                            >
                                <button
                                    className="cursor-pointer text-left hover:bg-gray-500 w-[calc(100%+1rem)] p-2 -m-2"
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
    // #endregion render
}
