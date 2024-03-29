'use client';

import {
    useState,
} from 'react';

import { loadStripe } from '@stripe/stripe-js';

import {
    EmbeddedCheckoutProvider,
    EmbeddedCheckout,
} from '@stripe/react-stripe-js';

import Spinner from '@/components/Spinner';
import LinkButton from '@/components/LinkButton';
import Subtitle from '@/components/Subtitle';

import {
    ENVIRONMENT,
} from '@/data';

import {
    focusStyle,
} from '@/data/styles';

import {
    computeTotalIntelligentActs,
} from '@/logic/user';

import {
    styleTrim,
} from '@/logic/utilities';

import useStore from '@/store';



const stripePromise = loadStripe(ENVIRONMENT.STRIPE_KEY, {
    locale: 'ro',
});


export default function BuyScreen({
    setShowBuyScreen,
} : {
    setShowBuyScreen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
    const {
        user,
    } = useStore();


    const [
        loading,
        setLoading,
    ] = useState(false);

    const [
        clientSecret,
        setClientSecret,
    ] = useState('');


    const buy = (
        productType: '300' | '1000' | '5000',
    ) => {
        setLoading(true);

        fetch(ENVIRONMENT.API_DOMAIN + '/stripe-checkout-sessions', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                productType,
            }),
        })
            .then((response) => response.json())
            .then((response) => {
                setLoading(false);

                if (response.status) {
                    setClientSecret(response.data.clientSecret);
                }
            })
            .catch((error) => {
                setLoading(false);

                console.log(error);
            });
    }


    const backButton = (
        <LinkButton
            text="înapoi"
            onClick={() => {
                setShowBuyScreen(false);
            }}
            centered={true}
        />
    );

    if (loading) {
        return (
            <div
                className="h-full flex items-center justify-center"
            >
                <Spinner />
            </div>
        );
    }

    if (clientSecret) {
        return (
            <div
                className="h-full min-h-[500px] md:min-w-[420px] overflow-scroll"
            >
                <EmbeddedCheckoutProvider
                    stripe={stripePromise}
                    options={{
                        clientSecret,
                    }}
                >
                    <EmbeddedCheckout />
                </EmbeddedCheckoutProvider>

                <div
                    className="m-8"
                >
                    {backButton}
                </div>
            </div>
        );
    }

    const buyButtonStyle = styleTrim(`
        font-bold w-full border border-gray-500 p-4 cursor-pointer select-none
        ${focusStyle}
    `);

    return (
        <>
            <div
                className="md:mx-auto"
            >
                <Subtitle
                    text={"cumpărare acte inteligente"}
                    centered={true}
                />
                {user && (
                    <div
                        className="text-center mb-4"
                    >
                        {computeTotalIntelligentActs(user)} acte inteligente disponibile
                    </div>
                )}
            </div>

            <div
                className="max-w-[400px]"
            >
                <p
                    className="text-center leading-normal"
                >
                    actele inteligente sunt folosite pentru procesarea documentelor în cloud-ul xfactura.ro
                    <br />
                    datele nu sunt stocate
                    <br />
                    1 act inteligent = 1 document procesat
                </p>
            </div>

            <div
                className="md:w-[300px] my-4 mx-auto md:mx-auto md:my-8 flex flex-col gap-8 justify-center items-center"
            >
                <button
                    className={buyButtonStyle}
                    onClick={() => buy('300')}
                >
                    <div>
                        70 RON
                    </div>

                    <div>
                        300 acte inteligente
                    </div>
                </button>

                <button
                    className={buyButtonStyle}
                    onClick={() => buy('1000')}
                >
                    <div>
                        150 RON
                    </div>

                    <div>
                        1.000 acte inteligente
                    </div>
                </button>

                <button
                    className={buyButtonStyle}
                    onClick={() => buy('5000')}
                >
                    <div>
                        500 RON
                    </div>

                    <div>
                        5.000 acte inteligente
                    </div>
                </button>
            </div>

            {backButton}
        </>
    );
}
