import BuyScreen from '@/components/BuyScreen';
import LoginScreen from '@/components/LoginScreen';

import useStore from '@/store';

import {
    styleTrim,
} from '@/logic/utilities';



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
            className={styleTrim(`
                scrollable-view max-w-xl h-full overflow-scroll flex flex-col md:justify-center p-2
            `)}
        >
            {user ? (
                <BuyScreen
                    setShowBuyScreen={() => {
                        back();
                    }}
                />
            ) : (
                <div
                    className="flex flex-col items-center justify-center m-auto gap-12"
                >
                    <LoginScreen
                        atLoginSuccess={() => {}}
                        back={() => back()}
                    />
                </div>
            )}
        </div>
    );
}
