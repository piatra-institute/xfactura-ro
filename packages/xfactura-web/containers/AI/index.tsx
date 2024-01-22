import MenuBack from '../../components/MenuBack';
import Subtitle from '../../components/Subtitle';



export default function AI({
    back,
} : {
    back: () => void;
}) {
    return (
        <div
            className="text-left"
        >
            <Subtitle
                text="acte inteligente"
                centered={true}
            />

            <MenuBack
                back={back}
            />
        </div>
    );
}
