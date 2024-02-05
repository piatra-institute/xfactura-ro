import {
    useState,
    useEffect,
} from 'react';

import LinkButton from '../LinkButton';
import Subtitle from '../Subtitle';
import TooltipQuestion from '../TooltipQuestion';
import BuyScreen from '../BuyScreen';
import LoginScreen from '../LoginScreen';

import useStore from '@/store';



export default function ActsModal({
    title,
    description,
    back,
    action,
} : {
    title: string;
    description: React.ReactNode;
    back: () => void;
    action: (
        type: 'local' | 'cloud',
    ) => void;
}) {
    // #region state
    const {
        user,
        usingLocalStorage,
    } = useStore();

    const [
        loggedIn,
        setLoggedIn,
    ] = useState(false);

    const [
        smartActsLeft,
        setSmartActsLeft,
    ] = useState(false);

    const [
        showLoginScreen,
        setShowLoginScreen,
    ] = useState(false);

    const [
        showBuyScreen,
        setShowBuyScreen,
    ] = useState(false);
    // #endregion state


    // #region effects
    useEffect(() => {
        if (user) {
            setLoggedIn(true);
        }

        // if (smartActs) {
        //     setSmartActsLeft(true);
        // }
    }, [
        user,
    ]);
    // #endregion effects


    // #region render
    const initialScreen = (
        <>
        <div
            className="grid gap-2 max-w-[350px]"
        >
            <div
                className="m-auto"
            >
                <Subtitle
                    text={title}
                />
            </div>

            <div>
                {description}
            </div>

            {usingLocalStorage ? (
                <div>
                    datele sunt stocate doar local
                </div>
            ) : (
                <div>
                    datele nu sunt stocate nici local, nici în cloud
                </div>
            )}
        </div>

        <div
            className="grid items-center justify-center gap-2"
        >
            <div
                className="flex items-center justify-center gap-2"
            >
                <LinkButton
                    text="procesare locală"
                    onClick={() => {
                        action('local');
                    }}
                />

                <TooltipQuestion
                    content={(
                        <p
                            style={{
                                margin: 0,
                            }}
                        >
                            folosire modele neuronale locale, timpul de încărcare și de procesare este mai mare, iar rezultatele sunt mai puțin precise
                        </p>
                    )}
                />
            </div>

            <div
                className="text-sm"
            >
                complet gratuit
            </div>
        </div>

        <div
            className="grid items-center justify-center gap-2"
        >
            <div
                className="flex items-center justify-center gap-2"
            >
                <LinkButton
                    text="procesare în cloud"
                    onClick={() => {
                        if (!loggedIn) {
                            setShowLoginScreen(true);
                            return;
                        }

                        if (!smartActsLeft) {
                            setShowBuyScreen(true);
                            return;
                        }

                        action('cloud');
                    }}
                />

                <TooltipQuestion
                    content={(
                        <p
                            style={{
                                margin: 0,
                            }}
                        >
                            folosire modele neuronale în cloud-ul xfactura.ro, timpul de încărcare și de procesare este scurt, iar rezultatele sunt mult mai precise
                        </p>
                    )}
                />
            </div>

            <div
                className="text-sm"
            >
                contra cost
            </div>
        </div>

        <LinkButton
            text="anulare"
            onClick={() => {
                back();
            }}
            centered={true}
        />
        </>
    );

    const loginScreen = (
        <LoginScreen
            atLoginSuccess={() => {
                setLoggedIn(true);
                setShowBuyScreen(true);
                setShowLoginScreen(false);
            }}
            back={() => {
                setShowLoginScreen(false);
            }}
        />
    );

    const buyScreen = (
        <BuyScreen
            setShowBuyScreen={setShowBuyScreen}
        />
    );

    const screen = showLoginScreen ? loginScreen
        : showBuyScreen ? buyScreen
        : initialScreen;

    return (
        <div
            className={`
                w-full h-full
                backdrop-blur-md
                fixed top-0 right-0 bottom-0 z-30
                grid items-center justify-center place-content-center gap-12
            `}
        >
            {screen}
        </div>
    );
    // #endregion render
}
