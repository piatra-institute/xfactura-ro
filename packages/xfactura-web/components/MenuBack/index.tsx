import LinkButton from '@/components/LinkButton';



export default function MenuBack({
    back,
    bottomSpace,
} : {
    back: () => void;
    bottomSpace?: boolean;
}) {
    return (
        <div
            className={
                `mt-8 flex justify-center font-bold ${bottomSpace ? 'mb-8' : ''}`
            }
        >
            <LinkButton
                text="înapoi"
                onClick={() => back()}
            />
        </div>
    );
}
