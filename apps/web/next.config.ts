import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  transpilePackages: ['@leadflow/shared'],
  reactStrictMode: true,
  poweredByHeader: false,
  // The browser talks to the API through the web origin so the httpOnly session cookie is first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};
export default config;
