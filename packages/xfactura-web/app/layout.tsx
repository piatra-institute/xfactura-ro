import { Inter } from 'next/font/google';

import type { Metadata } from 'next';
import type { Viewport } from 'next';

import { GoogleOAuthProvider } from '@react-oauth/google';

import './globals.css';

import {
    ENVIRONMENT,
} from '../data';



export const metadata: Metadata = {
    applicationName: 'xfactura.ro',
    title: 'xfactura.ro',
    description: 'generare e-factura',
    keywords: 'factura e-factura stocuri generare electronica online romania simpla simplificata contabilitate ai inteligenta artificiala',
    category: 'Business',
    creator: 'xfactura.ro',
    publisher: 'xfactura.ro',
    classification: 'Business',
    robots: 'index, follow',
    referrer: 'origin',
    metadataBase: new URL('https://xfactura.ro'),
    alternates: {
        canonical: 'https://xfactura.ro',
    },
    icons: {
        other: [
            {
                rel: 'mask-icon',
                url: '/safari-pinned-tab.svg',
                color: '#000000',
            },
        ],
    },
    openGraph: {
        type: 'website',
        url: 'https://xfactura.ro',
        title: 'xfactura.ro',
        description: 'generare e-factura',
        siteName: 'xfactura.ro',
        images: [
            {
                url: 'https://xfactura.ro/og.png',
            },
        ],
    },
    other: {
        'msapplication-TileColor': '#000000',
    },
};


export const viewport: Viewport = {
    themeColor: '#000000',
};


const inter = Inter({
    subsets: ['latin'],
});


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
