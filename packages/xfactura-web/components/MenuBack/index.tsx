import LinkButton from '../LinkButton';



export default function MenuBack({
    back,
} : {
    back: () => void;
}) {
    return (
        <div
            className="mt-8 flex justify-center font-bold"
        >
            <LinkButton
                text="înapoi"
                onClick={() => back()}
            />
        </div>
    );
}
