import BuyScreen from '@/components/BuyScreen';
import LoginScreen from '@/components/LoginScreen';

import useStore from '@/store';



export default function AI({
    back,
} : {
    back: () => void;
}) {
    const {
        user,
    } = useStore();

    return (
        <div
            className={`
                scrollable-view max-w-xl h-full overflow-scroll flex flex-col md:justify-center p-4
            `}
        >
            {user ? (
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
