'use client';

import { useRouter } from 'next/navigation';

import About from '@/containers/About';

import '@/app/globals.css';



export default function AboutPage() {
    const router = useRouter();

    return (
        <div
            className="flex flex-col items-center justify-center w-full h-screen"
        >
            <About
                back={() => router.push('/')}
            />
        </div>
    );
}
