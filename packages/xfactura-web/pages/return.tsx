import React, { useEffect, useState } from 'react';
import { redirect } from 'next/navigation';

import '../app/globals.css';



export default function Return() {
    const [status, setStatus] = useState(null);
    const [customerEmail, setCustomerEmail] = useState('');


    useEffect(() => {
        const queryString = window.location.search;
        const urlParams = new URLSearchParams(queryString);
        const sessionId = urlParams.get('session_id');

        fetch(`/api/checkout_sessions?session_id=${sessionId}`, {
            method: "GET",
        })
            .then((res) => res.json())
            .then((data) => {
                setStatus(data.status);
                setCustomerEmail(data.customer_email);
            });
    }, []);


    if (status === 'open') {
        return (
            redirect('/')
        );
    }

    if (status === 'complete') {
        return (
            <section
                id="success"
                className="flex flex-col items-center justify-center w-full h-screen px-4 text-center"
            >
                <p>
                    plata a fost efectuată cu succes · un email de confirmare a fost trimis la {customerEmail}
                </p>

                <p>
                    pentru alte întrebări <a href="mailto:contact@xfactura.ro">contact@xfactura.ro</a>
                </p>

                <a
                    href="/"
                    className="font-bold cursor-pointer"
                >
                    înapoi
                </a>
            </section>
        );
    }

    return null;
}
