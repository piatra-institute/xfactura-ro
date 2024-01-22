import {
    DetailedHTMLProps,
    ButtonHTMLAttributes,
} from 'react';



export type LinkButtonProps = {
    text: string | JSX.Element;
    centered?: boolean;
} & DetailedHTMLProps<ButtonHTMLAttributes<HTMLButtonElement>, HTMLButtonElement>;


export default function LinkButton({
    text,
    centered,
    ...rest
}: LinkButtonProps) {
    const button = (
        <button
            className="cursor-pointer select-none font-bold focus:outline-none focus:ring-2 focus:ring-white"
            {...rest}
        >
            {text}
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
