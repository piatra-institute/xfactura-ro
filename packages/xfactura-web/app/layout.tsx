import { GoogleOAuthProvider } from '@react-oauth/google';

import {
    ENVIRONMENT,
} from '@/data';

import fonts from '@/logic/fonts';

import './globals.css';

import {
    metadata,
    viewport,
} from './metadata';



export {
    metadata,
    viewport,
};

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode,
}) {
    return (
        <html
            lang="ro"
            suppressHydrationWarning
        >
            <body className={fonts}>
                <GoogleOAuthProvider
                    clientId={ENVIRONMENT.GOOGLE_LOGIN}
                >
                    {children}
                </GoogleOAuthProvider>
            </body>
        </html>
    );
}
