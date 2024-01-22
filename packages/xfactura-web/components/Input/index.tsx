import {
    DetailedHTMLProps,
    InputHTMLAttributes,
} from 'react';

import Spinner from '../Spinner';



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
            className={`flex relative items-center justify-between my-2 gap-4 ${asGrid ? 'lg:grid' : 'lg:flex'}`}
        >
            <div
                className="select-none"
            >
                {text}
            </div>

            <input
                className="bg-gray-800 w-[200px] p-2 border-none rounded-none text-white focus:outline-none focus:ring-2 focus:ring-white disabled:bg-gray-600"
                name={text}
                value={value}
                onChange={(event) => {
                    setValue(event.target.value);
                }}
                style={{
                    width,
                }}
                type={type}
                disabled={disabled}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                {...inputProps}
            />

            {loading && (
                <Spinner
                    absolute={true}
                    style={{
                        right: '4px',
                        top: '19px',
                    }}
                />
            )}
        </div>
    );
}
