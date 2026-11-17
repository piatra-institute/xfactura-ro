/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  typescript: {
    tsconfigPath: process.env.NEXT_TSCONFIG_PATH
      ? require('node:path').relative(__dirname, process.env.NEXT_TSCONFIG_PATH)
      : 'tsconfig.json',
  },
  transpilePackages: ['xfactura-api', 'xfactura-core'],
  experimental: {
    agentUpgrade: 'security',
  },
  outputFileTracingRoot: require('node:path').join(__dirname, '../..'),
  async rewrites() {
    const backend = process.env.ACCOUNTING_API_URL || 'http://127.0.0.1:8089';
    return [{ source: '/api/accounting/:path*', destination: `${backend}/api/accounting/:path*` }];
  },
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
    ];
  },
  images: {
    remotePatterns: [
      {
        hostname: '*.googleusercontent.com',
      },
    ],
  },
};

module.exports = nextConfig;
