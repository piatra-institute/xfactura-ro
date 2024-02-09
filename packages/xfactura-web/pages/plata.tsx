import React, {
    useEffect,
    useState,
} from 'react';

import {
    ENVIRONMENT,
} from '@/data';

import Spinner from '@/components/Spinner';

import '../app/globals.css';



export default function Payment() {
    const [status, setStatus] = useState(null);
    const [customerEmail, setCustomerEmail] = useState('');


    useEffect(() => {
        const queryString = window.location.search;
        const urlParams = new URLSearchParams(queryString);
        const sessionID = urlParams.get('sid');

        fetch(ENVIRONMENT.API_DOMAIN + `/stripe-checkout-sessions?sid=${sessionID}`, {
            method: 'GET',
            credentials: 'include',
        })
            .then((res) => res.json())
            .then((data) => {
                setStatus(data.status);
                setCustomerEmail(data.customer_email);
            });
    }, []);


    if (!status) {
        return (
            <Spinner />
        );
    }

    return (
        <section
            className="flex flex-col items-center justify-center w-full h-screen px-4 text-center"
        >
            {status !== 'complete' ? (
                <p>
                    plata a eșuat
                </p>
            ) : (
                <p
                    className="text-center"
                >
                    plata a fost efectuată cu succes
                    <br />
                    un email de confirmare a fost trimis la <span
                        className="font-bold select-all"
                    >
                        {customerEmail}
                    </span>
                </p>
            )}

            <p>
                pentru alte întrebări <a
                    className="underline"
                    href="mailto:contact@xfactura.ro"
                >
                    contact@xfactura.ro
                </a>
            </p>

            <a
                href="/"
                className="font-bold cursor-pointer"
            >
                acasă
            </a>
        </section>
    );
}
