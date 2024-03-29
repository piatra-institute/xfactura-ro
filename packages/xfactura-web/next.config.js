/** @type {import('next').NextConfig} */
const nextConfig = {
    async headers() {
        return [
            {
                source: '/',
                headers: [
                    // TOFIX
                    // {
                    //     key: 'Cross-Origin-Embedder-Policy',
                    //     value: 'require-corp',
                    // },
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin-allow-popups',
                    },
                ],
            },
        ]
    },
    images: {
        remotePatterns: [
            {
                hostname: '*.googleusercontent.com',
            },
        ],
    },
}

module.exports = nextConfig
