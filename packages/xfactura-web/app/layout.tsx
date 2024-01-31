import { Inter } from 'next/font/google';

import type { Metadata } from 'next';
import type { Viewport } from 'next';

import { GoogleOAuthProvider } from '@react-oauth/google';

import './globals.css';

import {
    ENVIRONMENT,
} from '../data';



const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
    applicationName: 'xfactura.ro',
    title: 'xfactura.ro',
    description: 'generare e-factura',
    keywords: `
        factura, e-factura, generare factura, factura electronica, factura online, factura romania, factura simpla, factura simplificata
    `.trim().replace(/\s+/g, ', '),
    category: 'Business',
    icons: {
        icon: [
            {
                rel: 'mask-icon',
                url: '/safari-pinned-tab.svg',
                color: '#000000',
            },
        ],
    },
    other: {
        'msapplication-TileColor': '#000000',
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
};


export const viewport: Viewport = {
    themeColor: '#000000',
}


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
