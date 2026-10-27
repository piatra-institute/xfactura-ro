'use server';

import Home from '@/containers/Home';

import getUser from '@/logic/getUser';
import LegacyProviders from '@/components/LegacyProviders';



export default async function Page() {
    const user = await getUser();

    return (
        <LegacyProviders><Home user={user} /></LegacyProviders>
    );
}
