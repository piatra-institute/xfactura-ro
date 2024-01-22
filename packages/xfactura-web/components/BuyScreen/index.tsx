import LinkButton from '../LinkButton';
import Subtitle from '../Subtitle';



export default function BuyScreen({
    setShowBuyScreen,
} : {
    setShowBuyScreen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
    return (
        <>
        <div
            className="m-auto"
        >
            <Subtitle
                text={"cumpărare acte inteligente"}
            />
        </div>

        <div
            className="max-w-[400px]"
        >
            actele inteligente sunt folosite pentru procesarea documentelor în cloud-ul xfactura.ro
            <br />
            datele nu sunt stocate
            <br />
            1 act inteligent = 1 document procesat
        </div>

        <div
            className="font-bold cursor-pointer select-none"
        >
            <div>
                70 RON
            </div>

            <div>
                300 acte inteligente
            </div>
        </div>

        <div
            className="font-bold cursor-pointer select-none"
        >
            <div>
                150 RON
            </div>

            <div>
                1.000 acte inteligente
            </div>
        </div>

        <div
            className="font-bold cursor-pointer select-none"
        >
            <div>
                500 RON
            </div>

            <div>
                5.000 acte inteligente
            </div>
        </div>

        <LinkButton
            text="înapoi"
            onClick={() => {
                setShowBuyScreen(false);
            }}
            centered={true}
        />
        </>
    );
}
