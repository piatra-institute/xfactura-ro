'use client';

import { GoogleOAuthProvider } from '@react-oauth/google';

export default function LegacyProviders({ children }: { children: React.ReactNode }) {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_LOGIN;
    return clientId ? <GoogleOAuthProvider clientId={clientId}>{children}</GoogleOAuthProvider> : <>{children}</>;
}
