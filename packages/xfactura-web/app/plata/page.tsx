'use client';

import React, {
    useEffect,
    useState,
} from 'react';

import {
    ENVIRONMENT,
} from '@/data';

import Spinner from '@/components/Spinner';

import {
    logger,
} from '@/logic/utilities';

import '@/app/globals.css';



export default function PaymentPage() {
    const [status, setStatus] = useState<boolean | null>(null);
    const [pending, setPending] = useState(false);
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
            .then((response) => {
                setStatus(response.status === true);
                setPending(response.data?.pending === true);

                if (response.status) {
                    setCustomerEmail(response.data.customerEmail);
                }
            })
            .catch((error) => {
                logger('error', error);
                setStatus(false);
            });
    }, []);


    if (status === null) {
        return (
            <Spinner />
        );
    }

    return (
        <section
            className="flex flex-col items-center justify-center w-full h-screen px-4 text-center"
        >
            {status ? (
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
            ) : pending ? (
                <p>
                    plata este în curs de procesare
                    <br />
                    actele vor fi adăugate în cont după confirmarea plății
                </p>
            ) : (
                <p>
                    plata a eșuat
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
