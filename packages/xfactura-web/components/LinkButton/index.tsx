import {
    DetailedHTMLProps,
    ButtonHTMLAttributes,
} from 'react';

import Image from 'next/image';



export type LinkButtonProps = {
    text: string | JSX.Element;
    centered?: boolean;
    icon?: string | JSX.Element;
} & DetailedHTMLProps<ButtonHTMLAttributes<HTMLButtonElement>, HTMLButtonElement>;


export default function LinkButton({
    text,
    centered,
    icon,
    ...rest
}: LinkButtonProps) {
    const button = (
        <button
            className={`
                cursor-pointer select-none font-bold
                flex items-center gap-2 p-1
                focus:outline-none focus:ring-2 focus:ring-white
                m-auto
            `}
            {...rest}
        >
            {typeof icon === 'string' ? (
                <Image
                    src={icon}
                    width={20}
                    height={20}
                    alt={typeof text === 'string' ? text : ''}
                />
            ) : (
                <>
                    {icon}
                </>
            )}

            {icon ? (
                <div>
                    {text}
                </div>
            ) : (
                <>{text}</>
            )}
        </button>
    );

    if (centered) {
        return (
            <div
                className="flex items-center justify-center gap-2"
            >
                {button}
            </div>
        );
    }

    return (
        <>
            {button}
        </>
    );
}
