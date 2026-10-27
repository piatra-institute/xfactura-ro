import fonts from '@/logic/fonts';
import '@fontsource-variable/inter';
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
                {children}
            </body>
        </html>
    );
}
