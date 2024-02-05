'use client';

import {
    useState,
} from 'react';

import { loadStripe } from '@stripe/stripe-js';

import {
    EmbeddedCheckoutProvider,
    EmbeddedCheckout,
} from '@stripe/react-stripe-js';

import LinkButton from '@/components/LinkButton';
import Subtitle from '@/components/Subtitle';

import {
    ENVIRONMENT,
} from '@/data';

import {
    focusStyle,
} from '@/data/styles';

import {
    styleTrim,
} from '@/logic/utilities';



const stripePromise = loadStripe(ENVIRONMENT.STRIPE_KEY, {
    locale: 'ro',
});


export default function BuyScreen({
    setShowBuyScreen,
} : {
    setShowBuyScreen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
    const [
        clientSecret,
        setClientSecret,
    ] = useState('');


    const buy = (
        productType: '300' | '1000' | '5000',
    ) => {
        fetch(ENVIRONMENT.API_DOMAIN + '/stripe-checkout-sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                productType,
            }),
        })
            .then((res) => res.json())
            .then((data) => setClientSecret(data.clientSecret));
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


    if (clientSecret) {
        return (
            <div
                className="h-full min-w-[420px] overflow-scroll"
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
                className="w-[300px] m-auto flex flex-col gap-8 justify-center items-center"
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
