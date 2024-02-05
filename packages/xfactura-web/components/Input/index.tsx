import {
    DetailedHTMLProps,
    InputHTMLAttributes,
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
}: {
    text: string;
    value: string;
    setValue: (value: string) => void;
    width?: number;
    type?: string;
    disabled?: boolean;
    loading?: boolean;
    inputProps?: InputProps;
    asGrid?: boolean;
}) {
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

            <input
                className={styleTrim(`
                    bg-gray-800 w-[200px] p-2 border-none rounded-none text-white
                    disabled:bg-gray-600
                    ${focusStyle}
                `)}
                name={text}
                value={value}
                onChange={(event) => {
                    setValue(event.target.value);
                }}
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
            />

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
