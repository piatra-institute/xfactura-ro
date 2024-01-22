import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

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
