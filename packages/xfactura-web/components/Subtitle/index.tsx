import {
    styleTrim,
} from '@/logic/utilities';



export default function Subtitle({
    text,
    centered,
} : {
    text: string;
    centered?: boolean;
}) {
    return (
        <h2
            className={styleTrim(`
                select-none text-xl mb-4
                ${centered ? 'text-center' : 'text-center md:text-left'}
            `)}
        >
            {text}
        </h2>
    );
}
