import type { Metadata } from 'next';
import type { Viewport } from 'next';



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
