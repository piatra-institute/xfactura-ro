import BuyScreen from '../../components/BuyScreen';
import LoginScreen from '../../components/LoginScreen';

import localStorage from '@/data/localStorage';



export default function AI({
    back,
} : {
    back: () => void;
}) {
    return (
        <div
            className={`
                w-full h-full
                fixed top-0 right-0 bottom-0 z-30
                grid items-center justify-center place-content-center gap-12
            `}
        >
            {localStorage.user ? (
                <BuyScreen
                    setShowBuyScreen={() => {
                        back();
                    }}
                />
            ) : (
                <LoginScreen
                    atLoginSuccess={() => {}}
                    back={() => back()}
                />
            )}
        </div>
    );
}
