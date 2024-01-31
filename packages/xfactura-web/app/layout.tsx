import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import Head from 'next/head';

import { GoogleOAuthProvider } from '@react-oauth/google';

import './globals.css';

import {
    ENVIRONMENT,
} from '../data';



const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
    title: 'xfactura.ro',
    description: 'generare e-factura',
};


export default function RootLayout({
    children,
}: {
    children: React.ReactNode,
}) {
    return (
        <html
            lang="ro"
            suppressHydrationWarning
        >
            <Head>
                <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
                <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
                <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
                <link rel="manifest" href="/site.webmanifest" />
                <meta name="msapplication-TileColor" content="#2b5797" />
                <meta name="theme-color" content="#000000" />
            </Head>

            <body className={inter.className}>
                <GoogleOAuthProvider
                    clientId={ENVIRONMENT.GOOGLE_LOGIN}
                >
                    {children}
                </GoogleOAuthProvider>
            </body>
        </html>
    );
}
