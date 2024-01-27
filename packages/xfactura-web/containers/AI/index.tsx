import BuyScreen from '../../components/BuyScreen';



export default function AI({
    back,
} : {
    back: () => void;
}) {
    return (
        <div
            className={`
                grid items-center justify-center place-content-center gap-12
            `}
        >
            <BuyScreen
                setShowBuyScreen={() => {
                    back();
                }}
            />
        </div>
    );
}
